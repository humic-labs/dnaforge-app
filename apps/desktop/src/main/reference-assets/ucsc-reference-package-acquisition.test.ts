// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireUcscReferencePackage,
  parseAcquireUcscReferencePackageCli,
  UCSC_REFERENCE_PACKAGE_ACQUISITION_V1,
  UCSC_REFERENCE_SOURCE_SET_V1,
} from './ucsc-reference-package-acquisition';
import { installHostedReferenceBodyReadGate } from './hosted-reference-transport';

const GENOME_ID = 'fixture1';
const FASTA = '>chr1\nACGTACGT\n>chrM\nAACCC\n';
const CHROM_SIZES = 'chr1\t8\nchrM\t5\n';
const GTF = 'chr1\tncbiRefSeq\texon\t1\t8\t.\t+\t.\tgene_id "G1"; transcript_id "T1";\n';
const FASTA_GZ = gzipSync(FASTA);
const GTF_GZ = gzipSync(GTF);
const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('UCSC reference-package acquisition', () => {
  it('downloads exact official-path inputs and seals their immutable source-set manifest', async () => {
    const requested: string[] = [];
    const { server, origin } = await sourceServer(requested);
    servers.push(server);
    const root = await temporaryRoot();
    const reserve = vi.fn(async () => undefined);
    const uninstallGate = installHostedReferenceBodyReadGate({ reserve });

    let result: Awaited<ReturnType<typeof acquireUcscReferencePackage>>;
    try {
      result = await acquireUcscReferencePackage({
        genomeId: GENOME_ID,
        outputDirectory: join(root, 'acquired'),
        sourceOrigin: origin,
        timeoutMs: 10_000,
      });
    } finally {
      uninstallGate();
    }

    expect(reserve).toHaveBeenCalledTimes(4);
    expect(reserve).toHaveBeenCalledWith(65_536, expect.any(AbortSignal));
    expect(requested).toEqual([
      `/goldenPath/${GENOME_ID}/bigZips/md5sum.txt`,
      `/goldenPath/${GENOME_ID}/bigZips/${GENOME_ID}.fa.gz`,
      `/goldenPath/${GENOME_ID}/bigZips/${GENOME_ID}.chrom.sizes`,
      `/goldenPath/${GENOME_ID}/bigZips/genes/${GENOME_ID}.ncbiRefSeq.gtf.gz`,
    ]);
    expect(result.receipt).toMatchObject({
      contract: UCSC_REFERENCE_PACKAGE_ACQUISITION_V1,
      genomeId: GENOME_ID,
      annotationTable: 'ncbiRefSeq',
      package: { fileName: `${GENOME_ID}.ucsc-source-set.json` },
      sources: {
        fasta: {
          fileName: `${GENOME_ID}.fa.gz`,
          sha256: sha256(FASTA_GZ),
          md5: md5(FASTA_GZ),
          byteLength: FASTA_GZ.byteLength,
        },
        chromSizes: {
          fileName: `${GENOME_ID}.chrom.sizes`,
          sha256: sha256(CHROM_SIZES),
          md5: md5(CHROM_SIZES),
          byteLength: Buffer.byteLength(CHROM_SIZES),
        },
        annotations: {
          fileName: `${GENOME_ID}.ncbiRefSeq.gtf.gz`,
          sha256: sha256(GTF_GZ),
          byteLength: GTF_GZ.byteLength,
        },
      },
    });
    const sourceSet = JSON.parse(await readFile(result.packagePath, 'utf8'));
    expect(sourceSet).toMatchObject({
      contract: UCSC_REFERENCE_SOURCE_SET_V1,
      genomeId: GENOME_ID,
      sources: result.receipt.sources,
    });
    expect(result.receipt.package).toMatchObject({
      sha256: sha256(await readFile(result.packagePath)),
      byteLength: (await readFile(result.packagePath)).byteLength,
    });
    expect(JSON.parse(await readFile(result.receiptPath, 'utf8'))).toEqual(result.receipt);
  });

  it('rejects an upstream MD5 mismatch and leaves no final source set', async () => {
    const { server, origin } = await sourceServer([], { fastaMd5: '0'.repeat(32) });
    servers.push(server);
    const root = await temporaryRoot();
    const outputDirectory = join(root, 'acquired');

    await expect(
      acquireUcscReferencePackage({
        genomeId: GENOME_ID,
        outputDirectory,
        sourceOrigin: origin,
        timeoutMs: 10_000,
      })
    ).rejects.toThrow(/publisher MD5/u);
    expect(await readdir(outputDirectory)).toEqual([]);
  });

  it('rejects non-UCSC network origins before making a request', async () => {
    const root = await temporaryRoot();

    await expect(
      acquireUcscReferencePackage({
        genomeId: GENOME_ID,
        outputDirectory: join(root, 'acquired'),
        sourceOrigin: 'https://example.com',
      })
    ).rejects.toThrow(/official UCSC source origin/u);
  });

  it('allows exactly one concurrent create-only acquisition to publish', async () => {
    const { server, origin } = await sourceServer([]);
    servers.push(server);
    const root = await temporaryRoot();
    const outputDirectory = join(root, 'acquired');
    const input = {
      genomeId: GENOME_ID,
      outputDirectory,
      sourceOrigin: origin,
      timeoutMs: 10_000,
    } as const;

    const outcomes = await Promise.allSettled([
      acquireUcscReferencePackage(input),
      acquireUcscReferencePackage(input),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect((await readdir(outputDirectory)).sort()).toEqual(
      [
        `${GENOME_ID}.chrom.sizes`,
        `${GENOME_ID}.fa.gz`,
        `${GENOME_ID}.md5sum.txt`,
        `${GENOME_ID}.ncbiRefSeq.gtf.gz`,
        `${GENOME_ID}.ucsc-acquisition.json`,
        `${GENOME_ID}.ucsc-source-set.json`,
      ].sort()
    );
  });

  it('parses only the create-only operator CLI surface', () => {
    expect(
      parseAcquireUcscReferencePackageCli(['--genome-id=hg19', '--output-directory=/tmp/ucsc'])
    ).toEqual({ genomeId: 'hg19', outputDirectory: '/tmp/ucsc' });
    expect(() =>
      parseAcquireUcscReferencePackageCli([
        '--genome-id=hg19',
        '--output-directory=/tmp/ucsc',
        '--source-origin=https://example.com',
      ])
    ).toThrow(/Unknown UCSC acquisition argument/u);
  });
});

async function sourceServer(
  requested: string[],
  overrides: Readonly<{ fastaMd5?: string }> = {}
): Promise<{ readonly server: Server; readonly origin: string }> {
  const md5Manifest = [
    `${overrides.fastaMd5 ?? md5(FASTA_GZ)}  ${GENOME_ID}.fa.gz`,
    `${md5(CHROM_SIZES)}  ${GENOME_ID}.chrom.sizes`,
    '',
  ].join('\n');
  const responses = new Map<string, Buffer>([
    [`/goldenPath/${GENOME_ID}/bigZips/md5sum.txt`, Buffer.from(md5Manifest)],
    [`/goldenPath/${GENOME_ID}/bigZips/${GENOME_ID}.fa.gz`, FASTA_GZ],
    [`/goldenPath/${GENOME_ID}/bigZips/${GENOME_ID}.chrom.sizes`, Buffer.from(CHROM_SIZES)],
    [`/goldenPath/${GENOME_ID}/bigZips/genes/${GENOME_ID}.ncbiRefSeq.gtf.gz`, GTF_GZ],
  ]);
  const server = createServer((request, response) => {
    requested.push(request.url ?? '');
    const body = responses.get(request.url ?? '');
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    sendResponse(response, body);
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function sendResponse(response: ServerResponse, body: Buffer): void {
  response.writeHead(200, {
    'content-length': String(body.byteLength),
    'last-modified': 'Sat, 29 Aug 2026 00:00:00 GMT',
  });
  response.end(body);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-ucsc-acquisition-'));
  temporaryRoots.push(root);
  return root;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  );
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function md5(value: string | Buffer): string {
  return createHash('md5').update(value).digest('hex');
}
