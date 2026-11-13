// @vitest-environment node

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReferenceAssetPreparationProgressUpdateV1 } from '../../shared/reference-assets-ipc';
import { installHostedReferenceBodyReadGate } from './hosted-reference-transport';
import {
  acquireHubGenomeFasta,
  downloadHubGenomeSequence,
  HubGenomeSequenceError,
  isNonGlobalHostname,
  resolveHubGenomeSequenceUrl,
} from './hub-genome-import';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const MIXED_FASTA = join(PROJECT_ROOT, 'test-fixtures/twobit/mixed.fa');
const MIXED_TWOBIT = join(PROJECT_ROOT, 'test-fixtures/twobit/mixed.2bit');
const PUBLIC = { allowLoopbackHttpForTests: false } as const;
const TEST = { allowLoopbackHttpForTests: true } as const;
const HUB = 'https://hub.example.org/yeast/hub.txt';

const temporaryRoots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dnaforge-hub-genome-'));
  temporaryRoots.push(root);
  return root;
}

type Route = (
  response: import('node:http').ServerResponse,
  request: import('node:http').IncomingMessage
) => void;

async function sequenceServer(
  routes: Record<string, Route>
): Promise<{ origin: string; requested: string[] }> {
  const requested: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    requested.push(path);
    const route = routes[path];
    if (!route) {
      response.statusCode = 404;
      response.end('missing');
      return;
    }
    route(response, request);
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requested };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function serveFile(bytes: Buffer, headers: Record<string, string> = {}): Route {
  return (response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      ...headers,
    });
    response.end(bytes);
  };
}

describe('resolveHubGenomeSequenceUrl', () => {
  it('resolves a relative twoBitPath against the hub and keeps an absolute one', () => {
    expect(
      resolveHubGenomeSequenceUrl(
        { hubUrl: HUB, genome: 'sacCer3', twoBitPath: 'sacCer3/sacCer3.2bit' },
        PUBLIC
      ).href
    ).toBe('https://hub.example.org/yeast/sacCer3/sacCer3.2bit');
    expect(
      resolveHubGenomeSequenceUrl(
        {
          hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
          genome: 'GCF_000146045.2',
          twoBitPath:
            'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/GCF_000146045.2.2bit',
        },
        PUBLIC
      ).href
    ).toBe(
      'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/GCF_000146045.2.2bit'
    );
  });

  it('refuses everything that is not a public HTTPS .2bit', () => {
    const cases: Array<[string, string]> = [
      ['http://hub.example.org/genome.2bit', 'HTTPS only'],
      ['https://user:pw@hub.example.org/genome.2bit', 'credentials'],
      ['https://hub.example.org/genome.2bit?token=1', 'credentials, a query, or a fragment'],
      ['https://hub.example.org/genome.2bit#x', 'credentials, a query, or a fragment'],
      ['https://hub.example.org/genome.fa.gz', '.2bit file'],
      ['https://10.0.0.8/genome.2bit', 'public host'],
      ['https://169.254.169.254/latest/meta.2bit', 'public host'],
      ['https://192.168.1.1/genome.2bit', 'public host'],
      ['https://[::1]/genome.2bit', 'public host'],
      ['https://[fc00::1]/genome.2bit', 'public host'],
      ['https://[::ffff:10.0.0.1]/genome.2bit', 'public host'],
      ['https://localhost/genome.2bit', 'public host'],
      ['https://api.localhost/genome.2bit', 'public host'],
      ['ftp://hub.example.org/genome.2bit', 'HTTPS only'],
    ];
    for (const [twoBitPath, reason] of cases) {
      expect(() =>
        resolveHubGenomeSequenceUrl({ hubUrl: HUB, genome: 'g', twoBitPath }, PUBLIC)
      ).toThrow(reason);
    }
    expect(() =>
      resolveHubGenomeSequenceUrl(
        { hubUrl: HUB, genome: 'bad genome', twoBitPath: 'a.2bit' },
        PUBLIC
      )
    ).toThrow('genome name is invalid');
    expect(() =>
      resolveHubGenomeSequenceUrl({ hubUrl: 'hub.txt', genome: 'g', twoBitPath: 'a.2bit' }, PUBLIC)
    ).toThrow('absolute URL');
    expect(() =>
      resolveHubGenomeSequenceUrl({ hubUrl: HUB, genome: 'g', twoBitPath: 'a.2bit' }, PUBLIC)
    ).not.toThrow();
  });

  it('admits loopback HTTP only for the explicit test runtime', () => {
    const locator = { hubUrl: HUB, genome: 'g', twoBitPath: 'http://127.0.0.1:47831/g.2bit' };
    expect(() => resolveHubGenomeSequenceUrl(locator, PUBLIC)).toThrow('HTTPS only');
    expect(resolveHubGenomeSequenceUrl(locator, TEST).href).toBe('http://127.0.0.1:47831/g.2bit');
    expect(() =>
      resolveHubGenomeSequenceUrl({ ...locator, twoBitPath: 'http://10.0.0.8/g.2bit' }, TEST)
    ).toThrow('HTTPS only');
  });

  it('classifies literal addresses', () => {
    expect(isNonGlobalHostname('hgdownload.soe.ucsc.edu')).toBe(false);
    expect(isNonGlobalHostname('8.8.8.8')).toBe(false);
    expect(isNonGlobalHostname('[2606:4700::1]')).toBe(false);
    expect(isNonGlobalHostname('100.64.0.1')).toBe(true);
    expect(isNonGlobalHostname('0.0.0.0')).toBe(true);
    expect(isNonGlobalHostname('[fe80::1]')).toBe(true);
    expect(isNonGlobalHostname('[::]')).toBe(true);
    expect(isNonGlobalHostname('[::ffff:a00:1]')).toBe(true);
    expect(isNonGlobalHostname('[::ffff:808:808]')).toBe(false);
  });
});

describe('downloadHubGenomeSequence', () => {
  it('streams a 2bit through the shared download policy and seals its digest', async () => {
    const bytes = await readFile(MIXED_TWOBIT);
    const { origin, requested } = await sequenceServer({
      '/hub/mixed.2bit': serveFile(bytes, { ETag: '"mixed-v1"' }),
    });
    const root = await temporaryRoot();
    const destinationPath = join(root, 'mixed.2bit');
    const reserve = vi.fn(async () => undefined);
    const uninstall = installHostedReferenceBodyReadGate({ reserve });
    const progress: Array<[number, number | null]> = [];
    let download: Awaited<ReturnType<typeof downloadHubGenomeSequence>>;
    try {
      download = await downloadHubGenomeSequence({
        url: new URL(`${origin}/hub/mixed.2bit`),
        destinationPath,
        policy: TEST,
        onProgress: (received, total) => progress.push([received, total]),
      });
    } finally {
      uninstall();
    }
    expect(reserve).toHaveBeenCalledWith(65_536, expect.any(AbortSignal));
    expect(requested).toEqual(['/hub/mixed.2bit']);
    expect(download).toEqual({
      url: `${origin}/hub/mixed.2bit`,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      etag: '"mixed-v1"',
    });
    expect(progress.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
    await expect(readFile(destinationPath)).resolves.toEqual(bytes);
    expect((await stat(destinationPath)).mode & 0o777).toBe(0o600);
  });

  it('follows a redirect only through admitted addresses', async () => {
    const bytes = await readFile(MIXED_TWOBIT);
    let origin = '';
    const server = await sequenceServer({
      '/old.2bit': (response) => {
        response.writeHead(302, { Location: `${origin}/new/mixed.2bit` });
        response.end();
      },
      '/private.2bit': (response) => {
        response.writeHead(302, { Location: 'https://10.0.0.8/escape.2bit' });
        response.end();
      },
      '/new/mixed.2bit': serveFile(bytes),
    });
    origin = server.origin;
    const root = await temporaryRoot();

    await expect(
      downloadHubGenomeSequence({
        url: new URL(`${origin}/old.2bit`),
        destinationPath: join(root, 'redirected.2bit'),
        policy: TEST,
      })
    ).resolves.toMatchObject({ url: `${origin}/new/mixed.2bit`, byteLength: bytes.byteLength });

    await expect(
      downloadHubGenomeSequence({
        url: new URL(`${origin}/private.2bit`),
        destinationPath: join(root, 'escaped.2bit'),
        policy: TEST,
      })
    ).rejects.toThrow('public host');
    expect(server.requested).toEqual(['/old.2bit', '/new/mixed.2bit', '/private.2bit']);
    await expect(stat(join(root, 'escaped.2bit'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a body that is not a 2bit file and leaves nothing behind', async () => {
    const { origin } = await sequenceServer({
      '/page.2bit': serveFile(Buffer.from('<html><body>Not found</body></html>')),
    });
    const root = await temporaryRoot();
    const destinationPath = join(root, 'page.2bit');
    await expect(
      downloadHubGenomeSequence({
        url: new URL(`${origin}/page.2bit`),
        destinationPath,
        policy: TEST,
      })
    ).rejects.toMatchObject({
      code: 'HUB_SEQUENCE_DOWNLOAD_FAILED',
      message: 'page.2bit is not a UCSC 2bit sequence file.',
    });
    await expect(stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds the transfer by declared and streamed size', async () => {
    const bytes = await readFile(MIXED_TWOBIT);
    const { origin, requested } = await sequenceServer({
      '/declared.2bit': serveFile(bytes),
      '/chunked.2bit': (response) => {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.write(bytes.subarray(0, 100));
        response.end(bytes.subarray(100));
      },
    });
    const root = await temporaryRoot();
    await expect(
      downloadHubGenomeSequence({
        url: new URL(`${origin}/declared.2bit`),
        destinationPath: join(root, 'declared.2bit'),
        policy: TEST,
        maxBytes: 200,
      })
    ).rejects.toThrow('beyond the 200-byte limit');
    await expect(
      downloadHubGenomeSequence({
        url: new URL(`${origin}/chunked.2bit`),
        destinationPath: join(root, 'chunked.2bit'),
        policy: TEST,
        maxBytes: 200,
      })
    ).rejects.toThrow('exceeds the 200-byte limit');
    expect(requested).toEqual(['/declared.2bit', '/chunked.2bit']);
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it('reports an HTTP failure with its status', async () => {
    const { origin } = await sequenceServer({});
    const root = await temporaryRoot();
    await expect(
      downloadHubGenomeSequence({
        url: new URL(`${origin}/missing.2bit`),
        destinationPath: join(root, 'missing.2bit'),
        policy: TEST,
      })
    ).rejects.toBeInstanceOf(HubGenomeSequenceError);
    await expect(
      downloadHubGenomeSequence({
        url: new URL(`${origin}/missing.2bit`),
        destinationPath: join(root, 'missing.2bit'),
        policy: TEST,
      })
    ).rejects.toThrow('HTTP 404');
  });
});

describe('acquireHubGenomeFasta', () => {
  it('downloads, unpacks, and keeps only the FASTA in staging', async () => {
    const bytes = await readFile(MIXED_TWOBIT);
    const { origin } = await sequenceServer({ '/lab/mixed.2bit': serveFile(bytes) });
    const root = await temporaryRoot();
    const stagingRoot = join(root, 'staging');
    const progress: ReferenceAssetPreparationProgressUpdateV1[] = [];
    const result = await acquireHubGenomeFasta({
      locator: { hubUrl: `${origin}/lab/hub.txt`, genome: 'mixed', twoBitPath: 'mixed.2bit' },
      stagingRoot,
      policy: TEST,
      onProgress: (update) => progress.push(update),
    });
    expect(result).toEqual({
      fastaPath: join(stagingRoot, 'mixed.fa'),
      download: expect.objectContaining({ byteLength: bytes.byteLength }),
      sequences: [
        { name: 'one', length: 231 },
        { name: 'two.2', length: 141 },
        { name: 'three-x', length: 1 },
        { name: 'four_n', length: 17 },
      ],
      totalBases: 390,
    });
    await expect(readFile(result.fastaPath, 'utf8')).resolves.toBe(
      await readFile(MIXED_FASTA, 'utf8')
    );
    await expect(readdir(stagingRoot)).resolves.toEqual(['mixed.fa']);
    expect(progress.map((update) => update.phase)).toEqual([
      'downloading-hub-sequence',
      'downloading-hub-sequence',
      'unpacking-hub-sequence',
      'unpacking-hub-sequence',
      'unpacking-hub-sequence',
      'unpacking-hub-sequence',
    ]);
    expect(progress[1]).toEqual({
      phase: 'downloading-hub-sequence',
      label: `Downloading mixed sequence from ${new URL(origin).host}`,
      completed: bytes.byteLength,
      total: bytes.byteLength,
    });
    expect(progress.at(-1)).toEqual({
      phase: 'unpacking-hub-sequence',
      label: 'Unpacking mixed sequence (four_n)',
      completed: 390,
      total: 390,
    });
  });

  it('applies the address policy before touching the network or disk', async () => {
    const root = await temporaryRoot();
    const fetchAsset = vi.fn();
    await expect(
      acquireHubGenomeFasta({
        locator: { hubUrl: HUB, genome: 'g', twoBitPath: 'http://169.254.169.254/g.2bit' },
        stagingRoot: join(root, 'staging'),
        policy: PUBLIC,
        fetchAsset,
        onProgress: () => undefined,
      })
    ).rejects.toMatchObject({ code: 'HUB_SEQUENCE_URL_REFUSED' });
    expect(fetchAsset).not.toHaveBeenCalled();
    await expect(readdir(root)).resolves.toEqual([]);
  });
});
