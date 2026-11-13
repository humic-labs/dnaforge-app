import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadSequenceDocumentBiologyFile, gitShowHead, isGitRepo, readTextFile } = vi.hoisted(
  () => ({
    loadSequenceDocumentBiologyFile: vi.fn(),
    gitShowHead: vi.fn(),
    isGitRepo: vi.fn(async () => true),
    readTextFile: vi.fn(),
  })
);

vi.mock('./path-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./path-utils')>();
  return {
    ...actual,
    loadSequenceDocumentBiologyFile,
  };
});

vi.mock('../../workspace/git', () => ({
  gitShowHead,
  isGitRepo,
}));

vi.mock('../../../platform', () => ({
  platform: () => ({
    fs: { readTextFile },
  }),
}));

import { createGetSequenceChangesTool as originalCreateGetSequenceChangesTool } from './get-sequence-changes';
import { checkedSequenceToolFactory } from '../../../test-utils/sequence-output-test-helper';
import { getSequenceChangesOutputSchema } from './sequence-output-schemas';
const createGetSequenceChangesTool = checkedSequenceToolFactory(
  originalCreateGetSequenceChangesTool,
  getSequenceChangesOutputSchema
);

import { execTool } from './test-helpers';

const FOLDER = { name: 'lab', path: '/ws/lab', addedAt: 1 };

function genbank(sequence: string, endings: '\n' | '\r\n' = '\n'): string {
  const body = [
    'LOCUS       test                     12 bp    DNA     linear',
    'ORIGIN',
    `        1 ${sequence}`,
    '//',
    '',
  ].join(endings);
  return body;
}

describe('get_sequence_changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadSequenceDocumentBiologyFile.mockResolvedValue({
      documentId: 'doc-1',
      sourcePath: '/ws/lab/plasmid.gb',
      biology: { format: 'genbank', sequence: { sequence: 'acgtacgtacgt' }, features: [] },
    });
    isGitRepo.mockResolvedValue(true);
  });

  it('reports the same one-base mutation for LF and CRLF GenBank files', async () => {
    const tool = createGetSequenceChangesTool([FOLDER]);
    gitShowHead.mockResolvedValue(genbank('acgtacgtacgt'));
    readTextFile.mockResolvedValue(genbank('acgtacgtacga'));

    const lf = await execTool<{ sequenceChanges: { mutations: number }; error?: string }>(tool, {
      documentId: 'doc-1',
    });
    expect(lf.error).toBeUndefined();
    expect(lf.sequenceChanges.mutations).toBe(1);

    gitShowHead.mockResolvedValue(genbank('acgtacgtacgt', '\r\n'));
    readTextFile.mockResolvedValue(genbank('acgtacgtacga', '\r\n'));
    const crlf = await execTool<{ sequenceChanges: { mutations: number }; error?: string }>(tool, {
      documentId: 'doc-1',
    });
    expect(crlf.error).toBeUndefined();
    expect(crlf.sequenceChanges.mutations).toBe(1);
  });

  it('returns an explicit error when ORIGIN cannot be extracted', async () => {
    const tool = createGetSequenceChangesTool([FOLDER]);
    gitShowHead.mockResolvedValue('LOCUS test');
    readTextFile.mockResolvedValue('LOCUS test');

    const result = await execTool<{ error?: string; sequenceChanges?: unknown }>(tool, {
      documentId: 'doc-1',
    });
    expect(result.sequenceChanges).toBeUndefined();
    expect(result.error).toMatch(/ORIGIN section is missing/i);
  });
});
