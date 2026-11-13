import { afterEach, describe, expect, it } from 'vitest';

import { assemblyAccession, sourceId } from '@waypoint/genome-data/annotation-catalog';

import {
  TRACK_CURRENT_SCHEMA,
  TRACK_META_SCHEMA,
  type TrackListing,
  type TrackMeta,
  type TrackStoreBridge,
} from '../../../shared/track-store';
import {
  annotationCatalogForAccession,
  findAnnotationCatalogForDocument,
  getAnnotationCatalogSnapshot,
  loadAnnotationCatalogs,
  refreshAnnotationCatalogs,
  resetAnnotationCatalogsForTests,
  subscribeAnnotationCatalogs,
} from './annotation-catalog-registry';
import { bundledStoreBridge } from './__tests__/bundled-store-bridge';

const GFF3 = (rows: string[]) =>
  ['##gff-version 3', '##sequence-region NC_000913.3 1 1000', ...rows].join('\n') + '\n';

function meta(track: string, overrides: Partial<TrackMeta> = {}): TrackMeta {
  return {
    schema: TRACK_META_SCHEMA,
    track,
    version: '0123456789ab',
    assembly: { accession: 'NC_000913.3', lengthBp: 4_641_652, aliases: ['U00096.3'] },
    file: { name: `${track}.gff3`, format: 'gff3', sha256: 'a'.repeat(64), byteLength: 1 },
    residency: { kind: 'managed' },
    kinds: ['terminator'],
    label: `Track ${track}`,
    evidence: 'measured',
    license: { spdx: 'CC0-1.0', attribution: 'Test data' },
    ...overrides,
  };
}

function listing(track: string, overrides: Partial<TrackListing> = {}): TrackListing {
  return {
    accession: 'NC_000913.3',
    track,
    current: { schema: TRACK_CURRENT_SCHEMA, version: '0123456789ab' },
    meta: meta(track),
    versions: ['0123456789ab'],
    problems: [],
    ...overrides,
  };
}

function fakeBridge(input: {
  readonly listings: Readonly<Record<string, readonly TrackListing[]>>;
  readonly files?: Readonly<Record<string, string>>;
  readonly refreshed?: () => void;
}): TrackStoreBridge {
  return {
    root: async () => '/fake/tracks',
    listAssemblies: async () => Object.keys(input.listings),
    listTracks: async (accession) => input.listings[accession] ?? [],
    readMeta: async (ref) => {
      const found = (input.listings[ref.accession] ?? []).find((l) => l.track === ref.track)?.meta;
      if (!found) throw new Error(`no meta for ${ref.track}`);
      return found;
    },
    readTrackFile: async (ref) => {
      const found = (input.listings[ref.accession] ?? []).find((l) => l.track === ref.track)?.meta;
      const text = input.files?.[ref.track];
      if (!found || text === undefined) throw new Error(`no file for ${ref.track}`);
      return { meta: found, path: `/fake/tracks/${ref.accession}/${ref.track}/x.gff3`, text };
    },
    refresh: async () => {
      input.refreshed?.();
      return { seeded: 0 };
    },
  };
}

afterEach(() => {
  resetAnnotationCatalogsForTests();
});

describe('annotation catalog registry', () => {
  it('builds one catalog per assembly from the store, with computed sources layered on top', async () => {
    const bridge = fakeBridge({
      listings: {
        'NC_000913.3': [
          listing('my-terminators'),
          listing('my-tss', { meta: meta('my-tss', { kinds: ['tss'] }) }),
        ],
      },
    });
    const snapshot = await loadAnnotationCatalogs(bridge);
    expect(snapshot.status).toBe('ready');
    const catalog = annotationCatalogForAccession('NC_000913.3');
    if (!catalog) throw new Error('expected a catalog');
    expect(catalog.displayName).toBe('E. coli K-12 MG1655');
    expect(catalog.assembly).toEqual({ accession: 'NC_000913.3', lengthBp: 4_641_652 });
    expect(catalog.sources.list().map((s) => s.id)).toEqual([
      'my-terminators',
      'my-tss',
      'promoter-windows-my-tss',
      'predicted-operons-50bp',
      'ecocyc-open-database',
    ]);
    expect(catalog.problems).toEqual([]);
  });

  it('matches a document by any identifier the assembly is known by, plus its length', async () => {
    await loadAnnotationCatalogs(
      fakeBridge({
        listings: {
          'NZ_CP000001.1': [
            listing('plasmid-terms', {
              accession: 'NZ_CP000001.1',
              meta: meta('plasmid-terms', {
                assembly: { accession: 'NZ_CP000001.1', lengthBp: 1000, aliases: ['CP000001.1'] },
              }),
            }),
          ],
        },
      })
    );
    const byAccession = findAnnotationCatalogForDocument({
      identifiers: ['NZ_CP000001.1'],
      lengthBp: 1000,
    });
    const byAlias = findAnnotationCatalogForDocument({
      identifiers: ['CP000001.1'],
      lengthBp: 1000,
    });
    expect(byAccession?.displayName).toBe('NZ_CP000001.1');
    expect(byAlias).toBe(byAccession);
    expect(
      findAnnotationCatalogForDocument({ identifiers: ['CP000001.1'], lengthBp: 999 })
    ).toBeNull();
    expect(findAnnotationCatalogForDocument({ identifiers: ['other'], lengthBp: 1000 })).toBeNull();
  });

  it('lists a broken track as unavailable with its reason, and drops one that names no drawable kind', async () => {
    await loadAnnotationCatalogs(
      fakeBridge({
        listings: {
          'NC_000913.3': [
            listing('half-written', {
              meta: null,
              current: null,
              problems: ['current.json does not exist.'],
            }),
            listing('stale-pointer', {
              problems: ['current.json names version 000000000000, which is not present.'],
            }),
            listing('coverage', { meta: meta('coverage', { kinds: ['coverage'] }) }),
            listing('odd-evidence', { meta: meta('odd-evidence', { evidence: 'experimental' }) }),
            listing('wrong-length', {
              meta: meta('wrong-length', {
                assembly: { accession: 'NC_000913.3', lengthBp: 1000, aliases: [] },
              }),
            }),
          ],
        },
      })
    );
    const catalog = annotationCatalogForAccession('NC_000913.3');
    if (!catalog) throw new Error('expected a catalog');
    expect(catalog.sources.get(sourceId('half-written'))).toBeUndefined();
    expect(catalog.sources.get(sourceId('coverage'))).toBeUndefined();
    expect(catalog.sources.get(sourceId('wrong-length'))).toBeUndefined();
    expect(catalog.sources.get(sourceId('stale-pointer'))?.availability).toEqual({
      status: 'unavailable',
      reason: 'current.json names version 000000000000, which is not present.',
    });
    expect(catalog.sources.get(sourceId('odd-evidence'))?.availability).toEqual({
      status: 'unavailable',
      reason: 'meta.json says evidence is "experimental"; it must be curated, measured or computed',
    });
    expect(catalog.problems).toEqual([
      'Tracks under NC_000913.3 disagree about the assembly length (4641652, 1000 bp); only 4641652 bp tracks are used.',
      expect.stringMatching(/^half-written: current\.json does not exist\./),
      'coverage: meta.json declares kinds [coverage], none of which the sequence viewer draws',
    ]);
  });

  it('loads a track file through the bridge and refuses invalid rows by name', async () => {
    const bridge = fakeBridge({
      listings: { 'NC_000913.3': [listing('t')] },
      files: {
        t: GFF3([
          'NC_000913.3\tt\tterminator\t10\t20\t.\t+\t.\tID=a',
          'U00096.3\tt\tterminator\t30\t40\t.\t-\t.\tID=b',
        ]),
      },
    });
    await loadAnnotationCatalogs(bridge);
    const source = annotationCatalogForAccession('NC_000913.3')?.sources.get(sourceId('t'));
    if (!source) throw new Error('expected the source');
    const context = {
      assembly: { accession: assemblyAccession('NC_000913.3'), lengthBp: 4_641_652 },
      genes: [],
      sequence: { lengthBp: 4_641_652, slice: () => '' },
      loadRecords: () => Promise.reject(new Error('unused')),
    };
    const records = await source.load(context);
    expect(records.map((r) => [r.id, r.strand])).toEqual([
      ['t:a', '+'],
      ['t:b', '-'],
    ]);

    const bad = fakeBridge({
      listings: { 'NC_000913.3': [listing('t')] },
      files: { t: GFF3(['NC_000913.3\tt\tterminator\t10\t20\t.\t.\t.\tID=nostrand']) },
    });
    resetAnnotationCatalogsForTests();
    await loadAnnotationCatalogs(bad);
    const badSource = annotationCatalogForAccession('NC_000913.3')?.sources.get(sourceId('t'));
    await expect(badSource?.load(context)).rejects.toThrow(
      'Track t: 1 invalid row(s) in t.gff3, e.g. line 3 (nostrand): strand must be + or -'
    );
  });

  it('shares one in-flight load, notifies subscribers, and refreshes through the store', async () => {
    let refreshes = 0;
    const bridge = fakeBridge({
      listings: { 'NC_000913.3': [listing('t')] },
      refreshed: () => {
        refreshes += 1;
      },
    });
    const seen: string[] = [];
    const unsubscribe = subscribeAnnotationCatalogs(() =>
      seen.push(getAnnotationCatalogSnapshot().status)
    );
    const [a, b] = await Promise.all([
      loadAnnotationCatalogs(bridge),
      loadAnnotationCatalogs(bridge),
    ]);
    expect(a).toBe(b);
    expect(seen).toEqual(['loading', 'ready']);
    await refreshAnnotationCatalogs(bridge);
    expect(refreshes).toBe(1);
    expect(seen).toEqual(['loading', 'ready', 'loading', 'ready']);
    unsubscribe();
  });

  it('reports a store that cannot be listed without losing what was loaded before', async () => {
    await loadAnnotationCatalogs(fakeBridge({ listings: { 'NC_000913.3': [listing('t')] } }));
    const broken: TrackStoreBridge = {
      ...fakeBridge({ listings: {} }),
      listAssemblies: async () => {
        throw new Error('disk gone');
      },
    };
    const snapshot = await loadAnnotationCatalogs(broken);
    expect(snapshot).toMatchObject({ status: 'error', message: 'disk gone' });
    expect(annotationCatalogForAccession('NC_000913.3')?.sources.get(sourceId('t'))).toBeDefined();
  });

  it('builds the bundled MG1655 catalog with every shipped source available', async () => {
    await loadAnnotationCatalogs(bundledStoreBridge());
    const catalog = annotationCatalogForAccession('NC_000913.3');
    if (!catalog) throw new Error('expected the bundled catalog');
    expect(catalog.problems).toEqual([]);
    const available = catalog.sources.list().filter((s) => s.availability.status === 'available');
    expect(available.map((s) => s.id).sort()).toEqual(
      [
        'adams2021-intrinsic-terminators',
        'adams2021-rho-termination',
        'ettwiller2016-tss',
        'termite-ecoli-terminators',
        'transtermhp-terminators',
        'yan2018-transcription-units',
        'yan2018-tss',
        'yan2018-unit-gene-lists',
        'yan2018-unit-gene-lists-merged',
        'promoter-windows-ettwiller2016-tss',
        'promoter-windows-yan2018-tss',
        'predicted-operons-50bp',
      ].sort()
    );
    expect(catalog.sources.get(sourceId('ecocyc-open-database'))?.availability.status).toBe(
      'unavailable'
    );
  });
});
