// @vitest-environment node

import { describe, expect, it } from 'vitest';
import type { Structure3dAttrs } from '../types';
import {
  structureKeyOverrideForAttrs,
  structureSourceIdentityKey,
} from './structureSourceIdentity';

const SOURCE: Structure3dAttrs = {
  source: 'alphafold',
  sourceId: 'P39702',
  providerIdentityKey: 'AFDB:P39702',
  uniprotId: 'P39702',
};

describe('structureSourceIdentityKey', () => {
  it('does not treat saved-selection provenance as a coordinate source change', () => {
    const before = structureSourceIdentityKey(SOURCE);
    const after = structureSourceIdentityKey({
      ...SOURCE,
      structureArtifactRef: {
        structureId: 'structure:afdb-p39702',
        artifactPath: 'Structures/AF-P39702-F1.cif',
        coordinateDigestSha256: 'a'.repeat(64),
      },
      savedSelectionRefs: [
        {
          selectionId: 'selection-1',
          revisionId: 'revision-1',
          artifactPath: 'Selections/selection-1.wpselection.json',
          visible: true,
        },
      ],
    });

    expect(after).toBe(before);
  });

  it('changes when the actual coordinate source changes', () => {
    expect(structureSourceIdentityKey({ ...SOURCE, uniprotId: 'P39703' })).not.toBe(
      structureSourceIdentityKey(SOURCE)
    );
  });

  it('uses a verified saved-coordinate digest as a bounded identity', () => {
    const data: Structure3dAttrs = {
      source: 'file',
      sourceId: 'ATOM '.repeat(1000),
      coordinateSha256: 'a'.repeat(64),
    };
    const key = structureSourceIdentityKey(data);
    expect(key.length).toBeLessThan(300);
    expect(key).not.toContain('ATOM');
    expect(structureSourceIdentityKey({ ...data, coordinateSha256: 'b'.repeat(64) })).not.toBe(key);
    expect(structureKeyOverrideForAttrs(data)).toBe(`saved-coordinate:sha256:${'a'.repeat(64)}`);
  });
});
