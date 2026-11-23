import { describe, expect, it } from 'vitest';
import { REGISTRY_FILE_TYPES } from './registry-file-types';
import { SUPPORTED_SEQUENCE_EXTENSIONS } from './scientific-file-types';
import { typedDocumentKindForPath } from './document-availability';
import { blockedDocument, DocumentReadError } from './document-read-failure';

describe('document opening inventory', () => {
  it.each(REGISTRY_FILE_TYPES)('covers the $id registry file format', ({ suffix }) => {
    const path = suffix.startsWith('.forge/')
      ? `/Work/Document/${suffix}`
      : `/Work/Document${suffix}`;
    expect(typedDocumentKindForPath(path)).toBeDefined();
  });

  it.each(SUPPORTED_SEQUENCE_EXTENSIONS)('covers ordinary sequence extension .%s', (suffix) => {
    expect(typedDocumentKindForPath(`/Work/Example.${suffix.toUpperCase()}`)).toBe(
      suffix === 'faa' ? 'protein' : 'sequence'
    );
  });

  it.each([
    ['Example.PDF', 'pdf'],
    ['Example.JPG', 'image'],
    ['Example.TSV', 'table'],
    ['Example.XLSX', 'table'],
    ['Example.HTM', 'html'],
    ['Example.MCIF', 'structure'],
    ['Example.BCIF', 'structure'],
    ['Example.GFF3.GZ', 'sequence'],
    ['Example.GBFF.GZ', 'sequence'],
    ['Document/.forge/table.json', 'table-package'],
    ['Protocol/.forge/protocol.json', 'protocol'],
    ['Run/.forge/protocol-run.json', 'protocol-run'],
    ['Run.DNAFORGE-PROTOCOL-RUN.JSON', 'protocol-run'],
    ['Example.txt', undefined],
    ['Example.json', undefined],
    ['Example.zip', undefined],
    ['table.json', undefined],
    ['protocol.json', undefined],
  ])('routes %s to the same document family on different platforms', (name, expected) => {
    expect(typedDocumentKindForPath(`/Work/${name}`)).toBe(expected);
    expect(typedDocumentKindForPath(`C:\\Work\\${name.replaceAll('/', '\\')}`)).toBe(expected);
  });
});

describe('document opening reasons', () => {
  it.each([
    ['ENOENT', 'missing'],
    ['ENOTDIR', 'missing'],
    ['EACCES', 'permission'],
    ['EPERM', 'permission'],
    ['EMFILE', 'unknown'],
    ['EIO', 'unknown'],
    ['EISDIR', 'unknown'],
  ])('reports actual system failure %s as %s', (code, reason) => {
    expect(blockedDocument(Object.assign(new Error('internal path'), { code }))).toMatchObject({
      state: 'blocked',
      code: reason,
      recognized: false,
    });
  });

  it.each([
    new Error('invalid syntax and ENOENT'),
    new SyntaxError('unrelated renderer exception'),
    new Error('a module is incompatible with v42'),
    undefined,
  ])('keeps unexplained failures neutral and avoids exposing raw errors', (error) => {
    expect(blockedDocument(error)).toEqual({
      state: 'blocked',
      code: 'unknown',
      recognized: false,
      reason: 'DNAForge couldn’t open this file.',
    });
  });

  it('preserves a verified type when one of its requirements fails', () => {
    const failure = new DocumentReadError('missing-asset', true, {
      detail: 'inaccessible internal path',
    });
    expect(blockedDocument(failure)).toEqual({
      state: 'blocked',
      code: 'missing-asset',
      recognized: true,
      reason: 'A file this document needs is missing. Ask for a complete copy.',
    });
  });
});
