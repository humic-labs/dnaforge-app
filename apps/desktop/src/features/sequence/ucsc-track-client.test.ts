// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  admitUcscTrack,
  describeUcscGenArkGenome,
  fetchUcscTrackRegion,
  fetchUcscWholeTrack,
  findUcscGenomes,
  genArkHubUrl,
  inspectUcscHub,
  listUcscPublicHubs,
  searchUcscTracks,
  UcscTrackRequestError,
} from './ucsc-track-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function hostedRuntime() {
  vi.stubGlobal('electronAPI', undefined);
  vi.stubGlobal('window', { location: { origin: 'https://staging.dnaforge.com' } });
  vi.stubGlobal('document', {
    documentElement: { dataset: { dnaforgeRuntime: 'hosted-browser' } },
  });
}

describe('UCSC sidecar client', () => {
  it('routes browser catalog searches through the authenticated website lookup route', async () => {
    hostedRuntime();
    const fetchImpl = vi.fn(async () => Response.json({ tracks: [] }));

    await expect(
      searchUcscTracks({ genome: 'hg38', query: 'genes' }, { fetchImpl })
    ).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://staging.dnaforge.com/api/external/ucsc/tracks/search',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('keeps a browser indexed-track grant on the website transport for subsequent range reads', async () => {
    hostedRuntime();
    const fetchImpl = vi.fn(async () =>
      Response.json({
        source_uri: 'https://hgdownload.soe.ucsc.edu/example.bb',
        source_token: 'opaque-test-source-grant',
        canonical_url_hash: 'a'.repeat(64),
        representation_sha256: 'b'.repeat(64),
        representation_identity_kind: 'content-sha256',
        byte_length: 1024,
        format: 'bigbed',
        expires_in_seconds: 600,
        provenance_id: 'fixture-provenance',
      })
    );

    const grant = await admitUcscTrack(
      { genome: 'hg38', track: 'knownGene', formatId: 'bigbed', probeChrom: 'chr1' },
      { fetchImpl }
    );
    expect(grant.baseUrl).toBe('https://staging.dnaforge.com/api');
    expect(grant.maxRangeBytes).toBe(4_000_000);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://staging.dnaforge.com/api/external/ucsc/tracks/admit',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('describes a hub by its advertised genomes and flags assembly hubs', async () => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            endpoint: '/list/hubGenomes',
            data: {
              hubUrl: 'https://hub.example.org/hub.txt',
              downloadTime: '2026-09-21T00:00:00',
              hg38: {
                organism: 'Human',
                description: 'Lab tracks',
                trackDbFile: 'hg38/trackDb.txt',
              },
              labAsm1: {
                organism: 'Lab strain',
                description: 'Lab assembly',
                trackDbFile: 'labAsm1/trackDb.txt',
                twoBitPath: 'labAsm1/labAsm1.2bit',
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      inspectUcscHub(' https://hub.example.org/hub.txt ', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({
      hubUrl: 'https://hub.example.org/hub.txt',
      genomes: [
        { name: 'hg38', organism: 'Human', description: 'Lab tracks', assemblyHub: false },
        {
          name: 'labAsm1',
          organism: 'Lab strain',
          description: 'Lab assembly',
          assemblyHub: true,
          twoBitPath: 'labAsm1/labAsm1.2bit',
        },
      ],
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      hub_url: 'https://hub.example.org/hub.txt',
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('searches UCSC assemblies and keeps only hub-backed GenArk accessions', async () => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            endpoint: '/findGenome',
            data: {
              downloadTime: '2026:09:22T00:00:00Z',
              browser: 'mustExist',
              q: 'yeast',
              itemCount: 3,
              'GCF_000146045.2': {
                commonName: "baker's yeast",
                scientificName: 'Saccharomyces cerevisiae',
                description: 'R64 559292 2014-12-17',
                browserExists: true,
                hubUrl: 'GCF/000/146/045/GCF_000146045.2/hub.txt',
              },
              'GCA_000001405.29': {
                scientificName: 'Homo sapiens',
                hubUrl: '/gbdb/genark/GCA/000/001/405/GCA_000001405.29/hub.txt',
              },
              sacCer3: { scientificName: 'Saccharomyces cerevisiae', browserExists: true },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      findUcscGenomes(' yeast ', { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toEqual([
      {
        accession: 'GCF_000146045.2',
        hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
        scientificName: 'Saccharomyces cerevisiae',
        commonName: "baker's yeast",
        description: 'R64 559292 2014-12-17',
      },
      {
        accession: 'GCA_000001405.29',
        hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCA/000/001/405/GCA_000001405.29/hub.txt',
        scientificName: 'Homo sapiens',
      },
    ]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8042/external/ucsc/api/findGenome');
    expect(JSON.parse(String(init.body))).toEqual({
      q: 'yeast',
      granted_capabilities: ['external-fetch:annotation'],
    });
  });

  it('describes a GenArk accession with its public hub address and refuses unknown ones', async () => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            endpoint: '/list/genarkGenomes',
            data: {
              hubUrlPrefix: '/gbdb/genark',
              genarkGenomes: {
                'GCF_000146045.2': {
                  hubUrl: 'GCF/000/146/045/GCF_000146045.2/hub.txt',
                  asmName: 'R64',
                  scientificName: 'Saccharomyces cerevisiae',
                  commonName: "baker's yeast",
                  taxId: 559292,
                  clade: 'fungi',
                },
              },
              itemsReturned: 1,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      describeUcscGenArkGenome('GCF_000146045.2', {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toEqual({
      accession: 'GCF_000146045.2',
      hubUrl: 'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt',
      assemblyName: 'R64',
      scientificName: 'Saccharomyces cerevisiae',
      commonName: "baker's yeast",
      taxId: 559292,
    });
    expect(
      JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    ).toEqual({ genome: 'GCF_000146045.2', granted_capabilities: ['external-fetch:annotation'] });
    await expect(
      describeUcscGenArkGenome('GCF_999.1', { fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow('UCSC GenArk does not list GCF_999.1.');
  });

  it('resolves every GenArk hub spelling to the public download tree', () => {
    expect(genArkHubUrl('GCF/000/146/045/GCF_000146045.2/hub.txt')).toBe(
      'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt'
    );
    expect(genArkHubUrl('/gbdb/genark/GCF/000/146/045/GCF_000146045.2/hub.txt')).toBe(
      'https://hgdownload.soe.ucsc.edu/hubs/GCF/000/146/045/GCF_000146045.2/hub.txt'
    );
    expect(genArkHubUrl(' https://hub.example.org/hub.txt ')).toBe(
      'https://hub.example.org/hub.txt'
    );
  });

  it("lists the public hub registry with each hub's advertised genomes", async () => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            endpoint: '/list/publicHubs',
            data: {
              publicHubs: [
                {
                  hubUrl: 'https://hub.example.org/hub.txt',
                  shortLabel: 'Example hub',
                  longLabel: 'Example public hub',
                  dbCount: 2,
                  dbList: 'hg38, mm10',
                },
                { shortLabel: 'No URL' },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      listUcscPublicHubs({ fetchImpl: fetchImpl as unknown as typeof fetch })
    ).resolves.toEqual([
      {
        hubUrl: 'https://hub.example.org/hub.txt',
        shortLabel: 'Example hub',
        longLabel: 'Example public hub',
        genomes: ['hg38', 'mm10'],
      },
    ]);
  });

  it('normalizes a short-lived range grant without persisting its credentials', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            source_uri: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5Base.bw',
            source_token: 'opaque-source-token',
            canonical_url_hash: 'canonical-hash',
            representation_sha256: 'd'.repeat(64),
            representation_identity_kind: 'strong-etag',
            format: 'bigwig',
            byte_length: 1_764_507_851,
            etag: '"etag"',
            last_modified: 'Mon, 28 Jul 2026 00:00:00 GMT',
            expires_in_seconds: 1_800,
            provenance_id: 'provenance-id',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      admitUcscTrack(
        {
          genome: 'hg38',
          track: 'gc5BaseBw',
          formatId: 'bigwig',
          probeChrom: 'chr1',
        },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).resolves.toMatchObject({
      baseUrl: 'http://127.0.0.1:8042',
      sourceToken: 'opaque-source-token',
      canonicalUrlHash: 'canonical-hash',
      representationSha256: 'd'.repeat(64),
      representationIdentityKind: 'strong-etag',
      expiresAtMs: 1_810_000,
    });
    now.mockRestore();
  });

  it.each([
    ['missing digest', undefined, 'strong-etag'],
    ['malformed digest', 'not-a-sha256', 'strong-etag'],
    ['unsupported identity kind', 'd'.repeat(64), 'last-modified'],
  ])('rejects a %s', async (_case, representationSha256, representationIdentityKind) => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const body: Record<string, unknown> = {
      source_uri: 'https://hgdownload.soe.ucsc.edu/gbdb/hg38/bbi/gc5Base.bw',
      source_token: 'opaque-source-token',
      canonical_url_hash: 'canonical-hash',
      format: 'bigwig',
      byte_length: 1_764_507_851,
      expires_in_seconds: 1_800,
      provenance_id: 'provenance-id',
    };
    if (representationSha256 !== undefined) {
      body.representation_sha256 = representationSha256;
    }
    body.representation_identity_kind = representationIdentityKind;
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(
      admitUcscTrack(
        { genome: 'hg38', track: 'gc5BaseBw', formatId: 'bigwig', probeChrom: 'chr1' },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).rejects.toThrow(/representation_sha256|invalid indexed-source metadata/u);
  });

  it('preserves structured terminal admission failures for result eligibility', async () => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              error: 'source_not_admitted',
              failure_kind: 'remote_http_error',
              message: 'The remote track file was not found (HTTP 404)',
              retryable: false,
              status_code: 404,
            },
          }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const result = admitUcscTrack(
      {
        genome: 'hg38',
        track: 'missingBigWig',
        formatId: 'bigwig',
        probeChrom: 'chr1',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    await expect(result).rejects.toMatchObject({
      name: 'UcscTrackRequestError',
      message: 'The remote track file was not found (HTTP 404)',
      code: 'remote_http_error',
      retryable: false,
      remoteStatusCode: 404,
    } satisfies Partial<UcscTrackRequestError>);
  });

  it('preserves structured retryable admission failures for the Retry action', async () => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: {
              error: 'source_not_admitted',
              failure_kind: 'remote_http_error',
              message: 'The remote track request failed (HTTP 503)',
              retryable: true,
              status_code: 503,
            },
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
    );

    const result = admitUcscTrack(
      {
        genome: 'hg38',
        track: 'temporarilyUnavailableBigWig',
        formatId: 'bigwig',
        probeChrom: 'chr1',
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    await expect(result).rejects.toMatchObject({
      name: 'UcscTrackRequestError',
      message: 'The remote track request failed (HTTP 503)',
      code: 'remote_http_error',
      retryable: true,
      remoteStatusCode: 503,
    } satisfies Partial<UcscTrackRequestError>);
  });

  it('leaves session injection to the Electron network boundary for catalog search', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('X-DNAForge-Session')).toBe(false);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        genome: 'hg38',
        query: 'gene',
        granted_capabilities: ['external-fetch:annotation'],
      });
      return new Response(
        JSON.stringify({
          tracks: [
            {
              track: 'knownGene',
              short_label: 'GENCODE',
              long_label: 'GENCODE genes',
              group: 'genes',
              track_type: 'bigGenePred',
              scientific_kind: 'transcript',
              format_id: 'bigbed',
              source_kind: 'ucsc-native',
              parent_track: 'genesSuper',
              parent_parent_track: 'annotations',
              catalog_color: '12,34,56',
              experiment_accession: 'ENCSR109DTU',
              file_accession: 'ENCFF230LAU',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });

    const tracks = await searchUcscTracks(
      { genome: 'hg38', query: 'gene' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8042/external/ucsc/tracks/search',
      expect.any(Object)
    );
    expect(tracks[0]).toMatchObject({
      track: 'knownGene',
      shortLabel: 'GENCODE',
      scientificKind: 'transcript',
      formatId: 'bigbed',
      sourceKind: 'ucsc-native',
      parentTrack: 'genesSuper',
      parentParentTrack: 'annotations',
      catalogColor: '12,34,56',
      experimentAccession: 'ENCSR109DTU',
      fileAccession: 'ENCFF230LAU',
    });
  });

  it('posts the exact GRCz12tu GenArk accession without a display-name alias', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        genome: 'GCF_049306965.2',
        query: 'genes',
        limit: 50,
        granted_capabilities: ['external-fetch:annotation'],
      });
      return new Response(JSON.stringify({ tracks: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });

    await searchUcscTracks(
      { genome: 'GCF_049306965.2', query: 'genes' },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:8042/external/ucsc/tracks/search',
      expect.any(Object)
    );
  });

  it('preserves hub identity through search and regional requests', async () => {
    const hubUrl = 'https://example.org/hg38/hub.txt';
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        return new Response(
          JSON.stringify({
            tracks: [
              {
                track: 'hubGenes',
                short_label: 'Hub genes',
                long_label: 'Genes from a public hub',
                track_type: 'bigBed',
                scientific_kind: 'interval',
                format_id: 'bigbed',
                source_kind: 'ucsc-hub',
                hub_url: hubUrl,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          records: [],
          complete: true,
          items_returned: 0,
          max_items_output: 10_000,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });

    const tracks = await searchUcscTracks(
      { genome: 'hg38', query: 'genes', hubUrl },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );
    await fetchUcscTrackRegion(
      {
        genome: 'hg38',
        track: 'hubGenes',
        chrom: 'chr1',
        start: 0,
        end: 2_000_000,
        hubUrl,
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch }
    );

    expect(tracks[0]).toMatchObject({
      sourceKind: 'ucsc-hub',
      hubUrl,
      track: 'hubGenes',
    });
    expect(bodies).toEqual([
      expect.objectContaining({ hub_url: hubUrl, query: 'genes' }),
      expect.objectContaining({ hub_url: hubUrl, track: 'hubGenes' }),
    ]);
  });

  it('preserves the regional completeness receipt', async () => {
    vi.stubGlobal('electronAPI', {
      config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            records: [{ chromStart: 100, chromEnd: 200 }],
            complete: true,
            items_returned: 1,
            max_items_output: 10_000,
            track_type: 'bigGenePred',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );

    await expect(
      fetchUcscTrackRegion(
        { genome: 'hg38', track: 'knownGene', chrom: 'chr1', start: 0, end: 1_000 },
        { fetchImpl: fetchImpl as unknown as typeof fetch }
      )
    ).resolves.toMatchObject({
      complete: true,
      itemsReturned: 1,
      maxItemsOutput: 10_000,
    });
  });

  it.each([undefined, 1_000_000])(
    'requests a bounded whole-track snapshot with limit %s without chromosome coordinates',
    async (maxItemsOutput) => {
      vi.stubGlobal('electronAPI', {
        config: { getApiUrl: async () => 'http://127.0.0.1:8042' },
      });
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          genome: 'hg38',
          track: 'cpgIslandExt',
          max_items_output: maxItemsOutput ?? 100_000,
          granted_capabilities: ['external-fetch:annotation'],
        });
        return new Response(
          JSON.stringify({
            records: [{ chrom: 'chr1', chromStart: 100, chromEnd: 200 }],
            complete: true,
            items_returned: 1,
            max_items_output: maxItemsOutput ?? 100_000,
            track_type: 'bed 4 +',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      await expect(
        fetchUcscWholeTrack(
          { genome: 'hg38', track: 'cpgIslandExt', maxItemsOutput },
          { fetchImpl: fetchImpl as unknown as typeof fetch }
        )
      ).resolves.toMatchObject({
        complete: true,
        itemsReturned: 1,
        maxItemsOutput: maxItemsOutput ?? 100_000,
      });
    }
  );
});
