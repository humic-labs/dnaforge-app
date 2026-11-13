import { describe, expect, it } from 'vitest';

import {
  decodeInlineReferenceUrl,
  encodeInlineReferenceDeclaration,
  INLINE_REFERENCE_SCHEME,
} from './codec';

describe('inline reference codec', () => {
  it('round-trips existing references, path entities, and workspace paths', () => {
    const declarations = [
      {
        kind: 'existing-reference' as const,
        referenceId: '5887a64e-1234-4678-9abc-def012345678',
      },
      {
        kind: 'path-entity' as const,
        entityType: 'sequence' as const,
        root: 'Research Workspace',
        segments: ['constructs', 'pUC19 final.gb'],
      },
      {
        kind: 'workspace-path' as const,
        root: 'Research Workspace',
        segments: ['results', 'alignment 01'],
      },
    ];

    for (const declaration of declarations) {
      const encoded = encodeInlineReferenceDeclaration(declaration);
      expect(encoded.startsWith(`${INLINE_REFERENCE_SCHEME}://`)).toBe(true);
      expect(decodeInlineReferenceUrl(encoded)).toEqual({ ok: true, declaration });
    }
  });

  it('rejects unsupported types and non-canonical UUIDs', () => {
    expect(
      decodeInlineReferenceUrl('dnaforge-chat://entity/alignment/workspace/example.aln')
    ).toEqual({ ok: false, code: 'unsupported-entity-type' });
    expect(decodeInlineReferenceUrl('dnaforge-chat://reference/not-a-uuid')).toEqual({
      ok: false,
      code: 'invalid-reference-id',
    });
  });

  it.each([
    'dnaforge-chat://workspace/root/..',
    'dnaforge-chat://workspace/root/%2e%2e',
    'dnaforge-chat://workspace/root/%2Fprivate',
    'dnaforge-chat://workspace/root/%5cprivate',
    'dnaforge-chat://workspace/root/folder?mode=open',
    'dnaforge-chat://workspace/root/folder#row',
    'dnaforge-chat://root@workspace/folder',
  ])('rejects inert hostile path input %s', (url) => {
    expect(decodeInlineReferenceUrl(url)).toMatchObject({ ok: false });
  });

  it('enforces the URI and segment size bounds', () => {
    const oversizedSegment = 'a'.repeat(256);
    expect(decodeInlineReferenceUrl(`dnaforge-chat://workspace/root/${oversizedSegment}`)).toEqual({
      ok: false,
      code: 'segment-too-long',
    });
    expect(decodeInlineReferenceUrl(`dnaforge-chat://workspace/root/${'a'.repeat(2_100)}`)).toEqual(
      { ok: false, code: 'uri-too-long' }
    );
  });
});
