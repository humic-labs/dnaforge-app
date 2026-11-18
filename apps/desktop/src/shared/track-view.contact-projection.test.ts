import { describe, expect, it } from 'vitest';
import { parseTrackViewDocument, serializeTrackViewDocument } from './track-view';
import { trackViewFixture } from './track-view-fixture';
import type { ContactProjectionViewState } from './contact-source';
import { trackViewMatchesSavedConfiguration } from '../features/sequence/track-view-configuration';

const contact: ContactProjectionViewState = {
  kind: 'contact-matrix',
  project: '/project',
  source: {
    schema: 'dnaforge.contact-source.v1',
    path: 'data/measured.contacts.json',
    sha256: 'a'.repeat(64),
    xReference: { id: 'pUC19', chrom: 'pUC19', length: 2686 },
    yReference: { id: 'other-reference', chrom: 'other', length: 5000 },
  },
  camera: {
    projectionId: `measured:${'a'.repeat(64)}`,
    xStart: 100,
    xEnd: 2000,
    yStart: 250,
    yEnd: 4500,
  },
};

describe('native contact projection saved view', () => {
  it('saves the exact source pointer and both cameras without embedding measurements', () => {
    const view = { ...trackViewFixture(), contactProjection: contact };
    const text = serializeTrackViewDocument(view);
    expect(parseTrackViewDocument(text).contactProjection).toEqual(contact);
    expect(text).not.toContain('cells');
    expect(text).not.toContain('matrix":[');
  });

  it('detects Y camera and source changes even when the ordinary X viewport is unchanged', () => {
    const saved = { ...trackViewFixture(), contactProjection: contact };
    expect(trackViewMatchesSavedConfiguration(saved, saved)).toBe(true);
    expect(
      trackViewMatchesSavedConfiguration(
        {
          ...saved,
          contactProjection: { ...contact, camera: { ...contact.camera!, yStart: 500 } },
        },
        saved
      )
    ).toBe(false);
    expect(
      trackViewMatchesSavedConfiguration(
        {
          ...saved,
          contactProjection: { ...contact, source: { ...contact.source, sha256: 'b'.repeat(64) } },
        },
        saved
      )
    ).toBe(false);
    expect(trackViewMatchesSavedConfiguration(trackViewFixture(), saved)).toBe(false);
  });

  it('refuses a contact X reference from another accession or length', () => {
    for (const xReference of [
      { id: 'U00096.2', chrom: 'U00096.2', length: 4_639_675 },
      { id: 'pUC19', chrom: 'pUC19', length: 2687 },
    ]) {
      expect(() =>
        serializeTrackViewDocument({
          ...trackViewFixture(),
          contactProjection: { ...contact, source: { ...contact.source, xReference } },
        })
      ).toThrow('contact X axis');
    }
  });

  it('refuses source traversal and out-of-reference camera ranges while retaining legacy views', () => {
    for (const changed of [
      { ...contact, source: { ...contact.source, path: '../foreign.contacts.json' } },
      { ...contact, camera: { ...contact.camera!, yEnd: 5001 } },
    ])
      expect(() =>
        serializeTrackViewDocument({ ...trackViewFixture(), contactProjection: changed })
      ).toThrow();
    expect(parseTrackViewDocument(serializeTrackViewDocument(trackViewFixture()))).toEqual(
      trackViewFixture()
    );
  });
});
