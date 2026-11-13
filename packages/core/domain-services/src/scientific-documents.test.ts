import { describe, expect, it } from 'vitest';
import {
  ScientificDocumentContractError,
  parseScientificDocumentIdentity,
  parseWorkspaceIdentity,
  scientificDocumentFailure,
  scientificDocumentFormat,
  validateScientificDocumentSnapshot,
} from './scientific-documents';

const SHA = 'a'.repeat(64);

describe('scientific document contract', () => {
  it('brands stable workspace and relative document identities', () => {
    expect(parseWorkspaceIdentity('workspace:42')).toBe('workspace:42');
    expect(parseScientificDocumentIdentity('sequences/pUC19.gb')).toBe('sequences/pUC19.gb');
  });

  it.each(['/tmp/pUC19.gb', '../pUC19.gb', 'a/../../pUC19.gb', 'C:\\pUC19.gb', './a.gb'])(
    'rejects non-relative or traversing identity %s',
    (identity) => {
      expect(() => parseScientificDocumentIdentity(identity)).toThrowError(
        expect.objectContaining<Partial<ScientificDocumentContractError>>({
          code: 'INVALID_DOCUMENT_IDENTITY',
        })
      );
    }
  );

  it('classifies supported formats without exposing a transport', () => {
    expect(scientificDocumentFormat(parseScientificDocumentIdentity('a.gb'))).toBe('genbank');
    expect(
      scientificDocumentFormat(parseScientificDocumentIdentity('a.data'), 'application/json')
    ).toBe('scientific-json');
    expect(scientificDocumentFormat(parseScientificDocumentIdentity('a.bin'), 'image/png')).toBe(
      'binary'
    );
  });

  it('validates exact UTF-8 byte length and revision identity', () => {
    const content = 'LOCUS       pUC19  2686 bp';
    expect(
      validateScientificDocumentSnapshot({
        workspace: parseWorkspaceIdentity('workspace:42'),
        document: parseScientificDocumentIdentity('sequences/pUC19.gb'),
        name: 'pUC19.gb',
        format: 'genbank',
        content,
        byteLength: new TextEncoder().encode(content).byteLength,
        revision: { kind: 'local-file', contentSha256: SHA },
        support: { route: 'desktop', access: 'read-write' },
      }).content
    ).toBe(content);
  });

  it.each([
    'DOCUMENT_NOT_FOUND',
    'INVALID_ENCODING',
    'ACCESS_DENIED',
    'SERVICE_UNAVAILABLE',
    'CANCELLED',
    'UNSUPPORTED_FORMAT',
  ] as const)('keeps %s as a stable result code', (code) => {
    expect(scientificDocumentFailure(code, 'bounded message')).toEqual({
      ok: false,
      error: { code, message: 'bounded message' },
    });
  });
});
