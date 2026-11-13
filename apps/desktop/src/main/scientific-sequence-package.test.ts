import { describe, expect, it } from 'vitest';
import { defineBlob } from '@waypoint/workspace-revisions';
import { serializeGenBank } from '@waypoint/sequence-utils';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { validateNewScientificSequencePackage } from './scientific-sequence-package';
import { SEQUENCE_PACKAGE_FORMAT_VERSION } from '../db/sequence-package-contract';

function entry() {
  const text = serializeGenBank({
    id: 'new-sequence',
    name: 'New sequence',
    sequence: '',
    length: 0,
    circular: false,
    annotations: [],
  });
  return {
    resourceId: 'new-sequence',
    path: 'New sequence/New sequence.gb',
    representation: { format: 'genbank-v1' as const, text },
    sequencePackageText: serializeSequencePackageDocument(
      buildSequencePackageDocument({
        id: 'new-sequence',
        name: 'New sequence',
        product: {
          file: 'New sequence.gb',
          genBankChecksum: defineBlob(new TextEncoder().encode(text)).hash,
        },
        updatedAt: '2026-10-08T21:00:00.000Z',
      })
    ),
  };
}

describe('accepted native sequence package validation', () => {
  it('refuses absent metadata instead of delivering a loose or half-described sequence', () => {
    expect(() =>
      validateNewScientificSequencePackage({ ...entry(), sequencePackageText: undefined })
    ).toThrow('require their package metadata');
  });
  it.each([
    ['identity', { id: 'other-id' }],
    ['name', { name: 'Other name' }],
    ['format', { formatVersion: 5 }],
    ['product', { product: { file: 'Other.gb', genBankChecksum: 'sha256:' + 'a'.repeat(64) } }],
    ['assembly', { assembly: { method: 'gibson' } }],
  ])('refuses mismatched %s before acceptance', (_name, patch) => {
    const supplied = entry();
    supplied.sequencePackageText = JSON.stringify({
      ...JSON.parse(supplied.sequencePackageText),
      ...patch,
    });
    expect(() => validateNewScientificSequencePackage(supplied)).toThrow();
  });
  it('refuses a changed GenBank checksum, duplicate metadata keys and package data attached to a primer', () => {
    const supplied = entry();
    expect(() =>
      validateNewScientificSequencePackage({
        ...supplied,
        representation: { format: 'genbank-v1', text: supplied.representation.text + '\n' },
      })
    ).toThrow('exact GenBank bytes');
    expect(() =>
      validateNewScientificSequencePackage({
        ...supplied,
        sequencePackageText: supplied.sequencePackageText.replace(
          `"formatVersion": ${SEQUENCE_PACKAGE_FORMAT_VERSION}`,
          `"formatVersion": ${SEQUENCE_PACKAGE_FORMAT_VERSION}, "formatVersion": ${SEQUENCE_PACKAGE_FORMAT_VERSION}`
        ),
      })
    ).toThrow();
    expect(() =>
      validateNewScientificSequencePackage({
        ...supplied,
        representation: { format: 'primer-v2', text: '{}' },
      })
    ).toThrow('Only a managed sequence');
  });
});
