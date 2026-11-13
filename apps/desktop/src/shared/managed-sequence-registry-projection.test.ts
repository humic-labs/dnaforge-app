import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildSequencePackageDocument,
  serializeSequencePackageDocument,
} from '../db/sequence-package';
import { projectManagedSequenceRegistry } from './managed-sequence-registry-projection';

const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function document() {
  return buildSequencePackageDocument({
    id: '90000000-0000-4000-8000-000000000001',
    name: 'Saved sequence',
    product: { file: 'product.gb', genBankChecksum: digest('complete GenBank bytes') },
    updatedAt: '2026-10-17T00:00:00.000Z',
  });
}

describe('complete saved sequence Registry association', () => {
  it('binds the actual saved marker bytes independently of whitespace normalization', async () => {
    const saved = document();
    const raw = ` \n${serializeSequencePackageDocument(saved)}\n`;
    const projection = await projectManagedSequenceRegistry(saved, undefined, 3, raw);
    expect(projection.fields._managedSequenceSnapshot).toEqual({
      version: 1,
      markerSha256: digest(raw),
    });
  });

  it('refuses a marker source that describes a different saved package', async () => {
    const saved = document();
    const substituted = serializeSequencePackageDocument({ ...saved, name: 'Different document' });
    await expect(projectManagedSequenceRegistry(saved, undefined, 3, substituted)).rejects.toThrow(
      /marker.*match/i
    );
  });

  it('distinguishes complete markers whose visible fields and product bytes are identical', async () => {
    const first = { ...document(), vendorState: { retained: ['first', { value: 0 }] } };
    const second = { ...first, vendorState: { retained: ['second', { value: 0 }] } };
    const one = await projectManagedSequenceRegistry(first);
    const two = await projectManagedSequenceRegistry(second);
    expect(one.name).toBe(two.name);
    expect(one.fields._managedSequenceContent).toEqual(two.fields._managedSequenceContent);
    expect(one.fields._managedSequenceSnapshot).toEqual({
      version: 1,
      markerSha256: digest(serializeSequencePackageDocument(first)),
    });
    expect(two.fields._managedSequenceSnapshot).toEqual({
      version: 1,
      markerSha256: digest(serializeSequencePackageDocument(second)),
    });
    expect(one.fields._managedSequenceSnapshot).not.toEqual(two.fields._managedSequenceSnapshot);
    expect(one.fields._managedSequenceProjectionVersion).toBe(3);
  });
});
