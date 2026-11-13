import { useSyncExternalStore } from 'react';

import {
  BUILTIN_ANNOTATION_VISUALIZATIONS,
  assemblyAccession,
  createAnnotationSourceCatalog,
  createAnnotationVisualizationCatalog,
  operonsByDistanceSource,
  promoterWindowsFromStartSitesSource,
  sourceId,
  type AnnotationSourceCatalog,
  type AnnotationSourceDefinition,
  type AnnotationVisualizationCatalog,
  type AssemblyIdentity,
} from '@waypoint/genome-data/annotation-catalog';

import { platform } from '../../../platform';
import type { TrackListing, TrackStoreBridge } from '../../../shared/track-store';
import { knownAssembly } from './known-assemblies';
import { defineStoreTrackSource } from './store-track-source';

export interface AnnotationCatalogForAssembly {
  readonly assembly: AssemblyIdentity;
  readonly displayName: string;
  readonly identifiers: readonly string[];
  readonly sources: AnnotationSourceCatalog;
  readonly visualizations: AnnotationVisualizationCatalog;
  readonly problems: readonly string[];
}

export type AnnotationCatalogSnapshot =
  | {
      readonly status: 'idle';
      readonly catalogs: ReadonlyMap<string, AnnotationCatalogForAssembly>;
    }
  | {
      readonly status: 'loading';
      readonly catalogs: ReadonlyMap<string, AnnotationCatalogForAssembly>;
    }
  | {
      readonly status: 'ready';
      readonly catalogs: ReadonlyMap<string, AnnotationCatalogForAssembly>;
    }
  | {
      readonly status: 'error';
      readonly catalogs: ReadonlyMap<string, AnnotationCatalogForAssembly>;
      readonly message: string;
    };

export const PREDICTED_OPERONS_SOURCE_ID = sourceId('predicted-operons-50bp');

export function promoterWindowsSourceIdFor(upstreamId: string) {
  return sourceId(`promoter-windows-${upstreamId}`);
}

const EMPTY: ReadonlyMap<string, AnnotationCatalogForAssembly> = new Map();
let snapshot: AnnotationCatalogSnapshot = { status: 'idle', catalogs: EMPTY };
let inFlight: Promise<AnnotationCatalogSnapshot> | null = null;
const listeners = new Set<() => void>();

function setSnapshot(next: AnnotationCatalogSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getAnnotationCatalogSnapshot(): AnnotationCatalogSnapshot {
  return snapshot;
}

export function subscribeAnnotationCatalogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAnnotationCatalogSnapshot(): AnnotationCatalogSnapshot {
  return useSyncExternalStore(
    subscribeAnnotationCatalogs,
    getAnnotationCatalogSnapshot,
    getAnnotationCatalogSnapshot
  );
}

export function annotationCatalogForAccession(
  accession: string
): AnnotationCatalogForAssembly | null {
  return snapshot.catalogs.get(accession) ?? null;
}

export function findAnnotationCatalogForDocument(document: {
  readonly identifiers: readonly string[];
  readonly lengthBp: number;
}): AnnotationCatalogForAssembly | null {
  const identifiers = new Set(document.identifiers.map((identifier) => identifier.trim()));
  for (const catalog of snapshot.catalogs.values()) {
    if (catalog.assembly.lengthBp !== document.lengthBp) continue;
    if (catalog.identifiers.some((identifier) => identifiers.has(identifier))) return catalog;
  }
  return null;
}

export function loadAnnotationCatalogs(
  bridge: TrackStoreBridge = platform().trackStore
): Promise<AnnotationCatalogSnapshot> {
  if (inFlight) return inFlight;
  setSnapshot({ status: 'loading', catalogs: snapshot.catalogs });
  inFlight = (async () => {
    try {
      const catalogs = new Map<string, AnnotationCatalogForAssembly>();
      for (const accession of await bridge.listAssemblies()) {
        const listings = await bridge.listTracks(accession);
        const catalog = buildCatalog(accession, listings, bridge);
        if (catalog) catalogs.set(accession, catalog);
      }
      setSnapshot({ status: 'ready', catalogs });
    } catch (error) {
      setSnapshot({
        status: 'error',
        catalogs: snapshot.catalogs,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = null;
    }
    return snapshot;
  })();
  return inFlight;
}

export async function refreshAnnotationCatalogs(
  bridge: TrackStoreBridge = platform().trackStore
): Promise<AnnotationCatalogSnapshot> {
  await bridge.refresh();
  return loadAnnotationCatalogs(bridge);
}

export function resetAnnotationCatalogsForTests(): void {
  snapshot = { status: 'idle', catalogs: EMPTY };
  inFlight = null;
}

function buildCatalog(
  accession: string,
  listings: readonly TrackListing[],
  bridge: TrackStoreBridge
): AnnotationCatalogForAssembly | null {
  const known = knownAssembly(accession);
  const problems: string[] = [];
  const lengths = new Set(
    listings.flatMap((listing) => (listing.meta ? [listing.meta.assembly.lengthBp] : []))
  );
  const lengthBp = known?.assembly.lengthBp ?? [...lengths][0];
  if (lengthBp === undefined) {
    return null;
  }
  if (lengths.size > 1 || (lengths.size === 1 && !lengths.has(lengthBp))) {
    problems.push(
      `Tracks under ${accession} disagree about the assembly length (${[...lengths].join(', ')} bp); only ${lengthBp} bp tracks are used.`
    );
  }
  const assembly: AssemblyIdentity = { accession: assemblyAccession(accession), lengthBp };

  const stored: AnnotationSourceDefinition[] = [];
  const aliases = new Set<string>([accession, ...(known?.identifiers ?? [])]);
  for (const listing of listings) {
    if (listing.meta && listing.meta.assembly.lengthBp !== lengthBp) continue;
    for (const alias of listing.meta?.assembly.aliases ?? []) aliases.add(alias);
    const { definition, problem } = defineStoreTrackSource(listing, bridge);
    if (definition) stored.push(definition);
    if (problem) problems.push(problem);
  }
  stored.sort((a, b) => a.id.localeCompare(b.id));

  const promoterWindows = stored
    .filter(
      (definition) =>
        definition.kinds.includes('tss') && definition.availability.status === 'available'
    )
    .map((upstream) =>
      promoterWindowsFromStartSitesSource({
        id: promoterWindowsSourceIdFor(upstream.id),
        upstream,
        upstreamBp: 60,
      })
    );
  const definitions = [
    ...stored,
    ...promoterWindows,
    operonsByDistanceSource({
      id: PREDICTED_OPERONS_SOURCE_ID,
      assembly: assembly.accession,
      options: { maxGapBp: 50, minGenes: 2 },
    }),
    ...(known?.unavailableSources ?? []),
  ];

  return {
    assembly,
    displayName: known?.displayName ?? accession,
    identifiers: [...aliases],
    sources: createAnnotationSourceCatalog(definitions),
    visualizations: createAnnotationVisualizationCatalog(BUILTIN_ANNOTATION_VISUALIZATIONS),
    problems,
  };
}
