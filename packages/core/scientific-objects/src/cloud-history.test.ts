import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import vectors from '../fixtures/scientific-cloud-digest-v1.json';
import {
  parseScientificCloudHistory,
  scientificCloudRequestHashInput,
  scientificCloudVersionHashInput,
} from './cloud-history';
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

it('matches independent canonical byte and digest vectors for null/UUID bases and Unicode namespaces', () => {
  for (const vector of vectors.vectors) {
    const history = parseScientificCloudHistory(vector.scientificHistory);
    const version = scientificCloudVersionHashInput(vector.manifestSha256, history);
    const request = scientificCloudRequestHashInput(
      vector.baseVersionId,
      vector.manifestSha256,
      history
    );
    expect(version).toBe(vector.versionHashInput);
    expect(digest(version)).toBe(vector.versionSha256);
    expect(request).toBe(vector.requestHashInput);
    expect(digest(request)).toBe(vector.requestSha256);
    if (vector.baseVersionId)
      expect(
        scientificCloudRequestHashInput(
          vector.baseVersionId.toUpperCase(),
          vector.manifestSha256,
          history
        )
      ).toBe(request);
  }
});

it('refuses malformed identities, unknown fields/formats, invalid archive identities and invalid conditional bases', () => {
  const vector = vectors.vectors[0]!;
  const raw = vector.scientificHistory;
  for (const value of [
    { ...raw, extra: true },
    { ...raw, formatVersion: 2 },
    { ...raw, logicalWorkspaceId: 'e\u0301' },
    { ...raw, logicalWorkspaceId: 'bad\u0000name' },
    { ...raw, acceptedHead: '' },
    { ...raw, archive: { ...raw.archive, hash: '2'.repeat(64) } },
    { ...raw, archive: { ...raw.archive, byteLength: -1 } },
  ])
    expect(() => parseScientificCloudHistory(value)).toThrow();
  const history = parseScientificCloudHistory(raw);
  expect(() => scientificCloudVersionHashInput('bad', history)).toThrow();
  for (const base of [undefined, '', 'foreign-not-a-version', 'e\u0301', '\ud800'])
    expect(() =>
      scientificCloudRequestHashInput(base as never, vector.manifestSha256, history)
    ).toThrow();
});
