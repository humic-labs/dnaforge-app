// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { decideImportDedup } from './import-dedup';
import type { ExistingWorkspaceFile } from './import-dedup';

function existing(name: string, contentHash: string, relPath = name): ExistingWorkspaceFile {
  return { name, contentHash, relPath };
}

describe('decideImportDedup  D3)', () => {
  it('imports new when nothing in the target matches', () => {
    const d = decideImportDedup({ name: 'a.gb', contentHash: 'h1' }, []);
    expect(d.action).toBe('import-new');
  });

  it('skips when the same name AND same content is already present (matchedByName)', () => {
    const d = decideImportDedup({ name: 'reads.fastq', contentHash: 'hX' }, [
      existing('reads.fastq', 'hX'),
    ]);
    expect(d).toEqual({
      action: 'skip-duplicate',
      existingRelPath: 'reads.fastq',
      matchedByName: true,
    });
  });

  it('catches identical content under a DIFFERENT name (the headline D3 case)', () => {
    const d = decideImportDedup({ name: 'reads_copy.fastq', contentHash: 'hX' }, [
      existing('reads.fastq', 'hX'),
    ]);
    expect(d).toEqual({
      action: 'skip-duplicate',
      existingRelPath: 'reads.fastq',
      matchedByName: false,
    });
  });

  it('flags a name collision when same name but different content', () => {
    const d = decideImportDedup({ name: 'reads.fastq', contentHash: 'hY' }, [
      existing('reads.fastq', 'hX'),
    ]);
    expect(d).toEqual({ action: 'name-collision', existingRelPath: 'reads.fastq' });
  });

  it('prefers a same-name content match when both a content match and a name collision exist', () => {
    const d = decideImportDedup({ name: 'reads.fastq', contentHash: 'hX' }, [
      existing('older.fastq', 'hX'),
      existing('reads.fastq', 'hY'),
    ]);
    expect(d.action).toBe('skip-duplicate');
    expect(d).toMatchObject({ existingRelPath: 'older.fastq', matchedByName: false });
  });
});
