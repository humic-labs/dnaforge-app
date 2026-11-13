import { describe, it, expect } from 'vitest';
import { toUserMessage } from '@waypoint/user-messages';
import { summarizeImportResult } from './import-result-summary';
import type { ImportExecResult } from './execute-import-outcome';

function res(over: Partial<ImportExecResult> = {}): ImportExecResult {
  return { imported: 0, skipped: 0, failed: 0, errors: [], written: [], ...over };
}

describe('summarizeImportResult  red-team #3 — never silent)', () => {
  it('success: imported only', () => {
    expect(summarizeImportResult(res({ imported: 3 }))).toEqual({
      message: 'Imported 3 items',
      type: 'success',
    });
  });

  it('success into a new workspace names it', () => {
    const r = summarizeImportResult(
      res({ imported: 2, createdNewWorkspace: true, createdWorkspaceName: 'Laura Export' })
    );
    expect(r.type).toBe('success');
    expect(r.message).toContain('Laura Export');
  });

  it('info: everything was a duplicate (would otherwise look like nothing happened)', () => {
    expect(
      summarizeImportResult(
        res({
          imported: 0,
          skipped: 2,
          skipBreakdown: { duplicates: 2, validation: 0 },
        })
      )
    ).toEqual({
      message: 'Already imported — skipped 2 duplicates',
      type: 'info',
    });
  });

  it('legacy skips without a known reason do not claim the files are duplicates', () => {
    expect(summarizeImportResult(res({ skipped: 2 }))).toEqual({
      message: 'Skipped 2 items',
      type: 'info',
    });
  });

  it.each([
    { imported: 0, message: 'Skipped 1 duplicate · skipped 1 item that failed validation' },
    {
      imported: 1,
      message: 'Imported 1 item · skipped 1 duplicate · skipped 1 item that failed validation',
    },
  ])('distinguishes validation skips with $imported imported items', ({ imported, message }) => {
    const result = res({ imported, skipped: 2, skipBreakdown: { duplicates: 1, validation: 1 } });
    expect(summarizeImportResult(result)).toEqual({ message, type: 'warning' });
    expect(result).toMatchObject({ imported, skipped: 2, failed: 0 });
  });

  it('nothing importable → "Couldn\'t import", never a "nothing" phrasing that implies a partial success', () => {
    const r = summarizeImportResult(res({ imported: 0, skipped: 0 }));
    expect(r.message).toBe("Couldn't import these files");
    expect(r.type).toBe('warning');
  });

  it('error: any failure makes the whole toast an error, even a partial success', () => {
    const r = summarizeImportResult(res({ imported: 1, failed: 1 }));
    expect(r.type).toBe('error');
    expect(r.message).toContain('1 item failed');
    expect(r.message).toContain('Imported 1 item');
  });

  it('describes a copied-but-unregistered file as one partial item with its reason', () => {
    const r = summarizeImportResult(
      res({
        imported: 1,
        failed: 1,
        written: [{ sourcePath: '/drop/multi.fasta', destPath: '/ws/multi.fasta' }],
        errors: [
          {
            sourcePath: '/drop/multi.fasta',
            error: 'contains 3 sequences — copied but not registered',
          },
        ],
      })
    );

    expect(r).toEqual({
      message:
        'Copied 1 item, but registry registration did not complete — contains 3 sequences — copied but not registered',
      type: 'error',
    });
    expect(r.message).not.toContain('Imported 1 item · 1 item failed');
  });

  it('explains the hard failure when a mixed batch also contains a copied partial item', () => {
    const r = summarizeImportResult(
      res({
        imported: 1,
        failed: 2,
        written: [{ sourcePath: '/drop/multi.fasta', destPath: '/ws/multi.fasta' }],
        errors: [
          {
            sourcePath: '/drop/multi.fasta',
            error: 'contains 3 sequences — copied but not registered',
          },
          { sourcePath: '/drop/blocked.gb', error: 'disk full' },
        ],
      })
    );

    expect(r).toEqual({
      message:
        'Copied 1 item, but registry registration did not complete · 1 item failed — disk full',
      type: 'error',
    });
  });

  it('singular vs plural', () => {
    expect(summarizeImportResult(res({ imported: 1 })).message).toBe('Imported 1 item');
  });

  it.each([
    res({ imported: 2 }),
    res({ imported: 2, createdNewWorkspace: true, createdWorkspaceName: 'Laura Export' }),
    res({ skipped: 2, skipBreakdown: { duplicates: 2, validation: 0 } }),
    res({ imported: 1, skipped: 2, skipBreakdown: { duplicates: 1, validation: 1 } }),
    res({ skipped: 2 }),
    res(),
  ])('the toast shows the summary as written for %j', (result) => {
    const { message } = summarizeImportResult(result);
    expect(toUserMessage(message)).toBe(message);
  });
});
