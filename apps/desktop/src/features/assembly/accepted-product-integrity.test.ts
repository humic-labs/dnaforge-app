// @vitest-environment node

import { computeChecksum } from '@waypoint/sequence-utils';
import { describe, expect, it } from 'vitest';
import { buildSequencePackageDocument } from '../../db/sequence-package';
import {
  assertReplaceProductAllowed,
  expectedAcceptedProductGenBankChecksum,
  inspectAcceptedProductIntegrity,
  ReplaceProductConfirmationRequired,
} from './accepted-product-integrity';

describe('accepted product integrity', () => {
  it('treats a changed GenBank file as drifted replace-product', async () => {
    const accepted = 'LOCUS       pX 4 bp DNA circular\nORIGIN\n        1 atgc\n//\n';
    const drifted = 'LOCUS       pX 4 bp DNA circular\nORIGIN\n        1 aaaa\n//\n';
    const expected = await computeChecksum(accepted);
    const actual = await computeChecksum(drifted);
    const files = new Map([['/lab/pX/pX.gb', drifted]]);

    const integrity = await inspectAcceptedProductIntegrity({
      productPath: '/lab/pX/pX.gb',
      expectedGenBankChecksum: expected,
      exists: async (path) => files.has(path),
      readTextFile: async (path) => {
        const content = files.get(path);
        if (!content) throw new Error(`missing ${path}`);
        return content;
      },
    });

    expect(integrity).toEqual({
      status: 'drifted',
      expectedGenBankChecksum: expected,
      actualGenBankChecksum: actual,
    });
    expect(() => assertReplaceProductAllowed({ constructId: 'construct-1', integrity })).toThrow(
      ReplaceProductConfirmationRequired
    );
    expect(() =>
      assertReplaceProductAllowed({
        constructId: 'construct-1',
        integrity,
        replaceProduct: true,
      })
    ).not.toThrow();
  });

  it('reads the accepted GenBank checksum from the package record', () => {
    const document = buildSequencePackageDocument({
      id: 'construct-1',
      name: 'pX',
      product: { file: 'pX.gb', genBankChecksum: 'sha256:file' },
      assembly: {
        accepted: {
          artifacts: { productGenBankChecksum: 'sha256:accepted' },
        },
      },
    });
    expect(expectedAcceptedProductGenBankChecksum(document)).toBe('sha256:accepted');
  });
});
