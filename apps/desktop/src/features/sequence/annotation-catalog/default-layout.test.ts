import { beforeAll, describe, expect, it } from 'vitest';

import {
  assemblyAccession,
  type AnnotationSourceDefinition,
  type SourceAvailability,
} from '@waypoint/genome-data/annotation-catalog';

import {
  type DefaultTrackFallback,
  defaultLayoutFallbacksFor,
  defaultLayoutFor,
  fallbackNotice,
  planDefaultLayout,
} from './default-layout';
import { loadAnnotationCatalogs } from './annotation-catalog-registry';
import { ECOLI_K12_MG1655_ASSEMBLY } from './known-assemblies';
import { bundledStoreBridge, bundledTrackNames } from './__tests__/bundled-store-bridge';

const ASSEMBLY = { accession: assemblyAccession('NC_000913.3'), lengthBp: 4_641_652 };

function fakeSources(entries: Record<string, SourceAvailability>) {
  return {
    get: (id: string) =>
      id in entries
        ? ({ id, availability: entries[id] } as unknown as AnnotationSourceDefinition)
        : undefined,
  };
}

const AVAILABLE: SourceAvailability = { status: 'available' };

describe('default annotation tracks', () => {
  beforeAll(async () => {
    await loadAnnotationCatalogs(bundledStoreBridge());
  });

  it('uses the first-choice source for every track when all are present, with no fallback notes', () => {
    const plan = planDefaultLayout({
      assembly: ASSEMBLY,
      sources: fakeSources({
        'promoter-windows-yan2018-tss': AVAILABLE,
        'promoter-windows-ettwiller2016-tss': AVAILABLE,
        'termite-ecoli-terminators': AVAILABLE,
        'adams2021-intrinsic-terminators': AVAILABLE,
        'transtermhp-terminators': AVAILABLE,
        'yan2018-unit-gene-lists-merged': AVAILABLE,
        'yan2018-unit-gene-lists': AVAILABLE,
        'yan2018-transcription-units': AVAILABLE,
        'predicted-operons-50bp': AVAILABLE,
        'yan2018-tss': AVAILABLE,
        'ettwiller2016-tss': AVAILABLE,
      }),
    });
    expect(
      plan.layout.tracks.map((track) => [
        track.id,
        track.sourceId,
        track.visualizationId,
        track.visible,
      ])
    ).toEqual([
      ['promoters', 'promoter-windows-yan2018-tss', 'promoter-arrow', true],
      ['terminators', 'termite-ecoli-terminators', 'terminator-hairpin', true],
      ['transcription-units', 'yan2018-unit-gene-lists-merged', 'transcription-unit-arrows', true],
      ['start-sites', 'yan2018-tss', 'position-ticks', false],
    ]);
    expect(plan.fallbacks).toEqual([]);
  });

  it('falls back in order and says which source is in use and why', () => {
    const plan = planDefaultLayout({
      assembly: ASSEMBLY,
      sources: fakeSources({
        'promoter-windows-ettwiller2016-tss': AVAILABLE,
        'termite-ecoli-terminators': { status: 'unavailable', reason: 'Not licensed here' },
        'transtermhp-terminators': AVAILABLE,
        'predicted-operons-50bp': AVAILABLE,
        'ettwiller2016-tss': AVAILABLE,
      }),
    });
    const sourceByTrack = new Map<string, string>(
      plan.layout.tracks.map((track) => [track.id, track.sourceId])
    );
    expect(sourceByTrack.get('promoters')).toBe('promoter-windows-ettwiller2016-tss');
    expect(sourceByTrack.get('terminators')).toBe('transtermhp-terminators');
    expect(sourceByTrack.get('transcription-units')).toBe('predicted-operons-50bp');
    expect(sourceByTrack.get('start-sites')).toBe('ettwiller2016-tss');

    const notes = new Map<string, DefaultTrackFallback>(
      plan.fallbacks.map((fallback) => [fallback.trackId, fallback])
    );
    expect(notes.size).toBe(4);
    const terminators = notes.get('terminators');
    if (!terminators) throw new Error('terminators should have fallen back');
    expect(terminators.reason).toBe('unavailable');
    expect(fallbackNotice(terminators)).toBe("Using TransTermHP because TERMITe isn't available.");
    const units = notes.get('transcription-units');
    if (!units) throw new Error('units should have fallen back');
    expect(fallbackNotice(units)).toBe(
      "Using Predicted operons because Yan 2018 unit gene lists, one per gene set isn't in this build."
    );
  });

  it('builds the MG1655 defaults from the bundled tracks', async () => {
    await loadAnnotationCatalogs(bundledStoreBridge());
    const layout = defaultLayoutFor(ECOLI_K12_MG1655_ASSEMBLY.accession);
    if (!layout) throw new Error('MG1655 must have a default layout');
    const registered = new Set(await bundledTrackNames(ECOLI_K12_MG1655_ASSEMBLY.accession));
    const sourceByTrack = new Map<string, string>(
      layout.tracks.map((track) => [track.id, track.sourceId])
    );
    const firstRegistered = (ids: readonly string[]) => ids.find((id) => registered.has(id));

    const tss = firstRegistered(['yan2018-tss', 'ettwiller2016-tss']);
    expect(sourceByTrack.get('start-sites')).toBe(tss);
    expect(sourceByTrack.get('promoters')).toBe(tss ? `promoter-windows-${tss}` : undefined);
    expect(sourceByTrack.get('terminators')).toBe(
      firstRegistered([
        'termite-ecoli-terminators',
        'adams2021-intrinsic-terminators',
        'transtermhp-terminators',
      ])
    );
    expect(sourceByTrack.get('transcription-units')).toBe(
      firstRegistered([
        'yan2018-unit-gene-lists-merged',
        'yan2018-unit-gene-lists',
        'yan2018-transcription-units',
      ]) ?? 'predicted-operons-50bp'
    );
    expect(defaultLayoutFor('NC_000001.11')).toBeNull();
    expect(defaultLayoutFallbacksFor('NC_000001.11')).toEqual([]);
  });
});
