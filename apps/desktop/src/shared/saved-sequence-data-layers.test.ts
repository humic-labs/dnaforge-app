import { describe, expect, it } from 'vitest';
import { sequenceDataLayerIndexedTargetId } from './sequence-data-layer-indexed-target';
import {
  captureSavedSequenceDataLayers,
  savedSequenceDataLayersSchema,
  sequenceDataLayerSelectionFromSaved,
} from './saved-sequence-data-layers';
import { parseTrackViewDocument, serializeTrackViewDocument } from './track-view';
import { trackViewFixture } from './track-view-fixture';
import { trackViewMatchesSavedConfiguration } from '../features/sequence/track-view-configuration';
import type { PublishedSequenceDataLayer } from './sequence-data-layer';

const id = `layer-${'a'.repeat(64)}`;
const revision = 'b'.repeat(64);
const targetDocumentId = sequenceDataLayerIndexedTargetId({
  referenceId: 'local-1234567890abcdef12345678',
  chrom: 'pUC19',
  sequenceIdentity: 'c'.repeat(64),
  annotationIdentity: 'd'.repeat(64),
});
const presentation = {
  sampleId: 'value',
  signalVisible: true,
  annotationColors: true,
  style: {
    geometry: 'points' as const,
    colorScale: {
      kind: 'continuous' as const,
      domain: [0, 1] as [number, number],
      colors: ['#000000', '#ffffff'],
      missingColor: '#cccccc',
      transform: 'linear' as const,
    },
  },
};
const source = {
  revision,
  document: { id, target: { documentId: targetDocumentId }, presentation },
} as PublishedSequenceDataLayer;
const selection = {
  project: '/project',
  layerId: id,
  visibleLayerIds: [id],
  presentationByLayerId: { [id]: presentation },
};

describe('saved indexed data layer sources', () => {
  it('round trips native source versions and presentation without embedding measurements', () => {
    const sequenceDataLayers = captureSavedSequenceDataLayers(targetDocumentId, selection, [
      source,
    ]);
    expect(sequenceDataLayerSelectionFromSaved(sequenceDataLayers)).toEqual(selection);
    const saved = parseTrackViewDocument(
      serializeTrackViewDocument({ ...trackViewFixture(), sequenceDataLayers })
    );
    expect(saved.sequenceDataLayers).toEqual(sequenceDataLayers);
    expect(
      trackViewMatchesSavedConfiguration(saved, {
        ...saved,
        sequenceDataLayers: {
          ...sequenceDataLayers!,
          layers: [{ id, revision: 'f'.repeat(64), presentation }],
        },
      })
    ).toBe(false);
    expect(
      trackViewMatchesSavedConfiguration(saved, {
        ...saved,
        sequenceDataLayers: {
          ...sequenceDataLayers!,
          layers: [{ id, revision, presentation: { ...presentation, sampleId: 'other' } }],
        },
      })
    ).toBe(false);
    expect(serializeTrackViewDocument(saved)).not.toContain('observations');
  });
  it('preserves an explicit all-hidden view', () => {
    const saved = captureSavedSequenceDataLayers(
      targetDocumentId,
      { project: '/project', layerId: null, visibleLayerIds: [] },
      []
    );
    expect(sequenceDataLayerSelectionFromSaved(saved)).toMatchObject({
      layerId: null,
      visibleLayerIds: [],
    });
  });
  it('refuses missing, substituted or changed selected source versions', () => {
    expect(() => captureSavedSequenceDataLayers(targetDocumentId, selection, null)).toThrow(
      /opening/u
    );
    expect(() => captureSavedSequenceDataLayers(targetDocumentId, selection, [])).toThrow(
      /unavailable/u
    );
    expect(() =>
      captureSavedSequenceDataLayers(targetDocumentId, selection, [source], {
        [id]: 'e'.repeat(64),
      })
    ).toThrow(/revision/u);
    expect(() =>
      savedSequenceDataLayersSchema.parse({
        project: '/project',
        targetDocumentId,
        selectedLayerId: id,
        visibleLayerIds: [id],
        layers: [],
      })
    ).toThrow();
  });
  it('refuses a source binding for another reference while preserving old view files', () => {
    expect(
      parseTrackViewDocument(serializeTrackViewDocument(trackViewFixture())).sequenceDataLayers
    ).toBeUndefined();
    const sequenceDataLayers = captureSavedSequenceDataLayers(targetDocumentId, selection, [
      source,
    ]);
    expect(() =>
      serializeTrackViewDocument({
        ...trackViewFixture(),
        reference: { ...(trackViewFixture().reference as object), assemblyId: 'another-reference' },
        sequenceDataLayers,
      })
    ).toThrow(/reference/u);
  });
});
