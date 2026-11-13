import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportErrorForDisplay } from './error-details';
import { userMessage } from '@waypoint/user-messages';

afterEach(() => vi.restoreAllMocks());

const SENSITIVE =
  "Error invoking remote method 'db:select': Error: SqliteError: SQLITE_CORRUPT: database disk image is malformed (/Users/jane/Projects/secret-crispr-screen/waypoint.db, stmt 'SELECT value FROM settings WHERE key = ?') owner jane.doe@example.org";

describe('reportErrorForDisplay ', () => {
  it('shows approved wording and a reference without classes, codes or diagnostic text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = reportErrorForDisplay(SENSITIVE, 'startup workspace');
    expect(report.summary).toBe(userMessage('operation.failed'));
    for (const shown of [report.summary, report.copyText]) {
      expect(shown).not.toMatch(
        /jane|secret-crispr|SELECT|settings|jane\.doe|example\.org|Users|invoking|SqliteError|SQLITE_CORRUPT/u
      );
    }
    expect(report.copyText).not.toContain('Where:');
    expect(report.copyText).toContain(`Reference: ${report.reference}`);
  });

  it('logs the full error under the same reference', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = reportErrorForDisplay(
      new TypeError('x is undefined at /Users/jane/a.ts'),
      'tab pUC19'
    );
    expect(report.summary).toBe(userMessage('operation.failed'));
    expect(report.reference).toMatch(/^E-[2-9A-Z]{8}$/u);
    expect(log).toHaveBeenCalledWith(
      `[ErrorReport ${report.reference}] tab pUC19:`,
      expect.stringContaining('/Users/jane/a.ts')
    );
  });

  it('keeps file-system codes in diagnostics and uses approved fallback wording', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(reportErrorForDisplay("ENOENT: no such file '/Users/jane/x'", 'x').summary).toBe(
      userMessage('operation.failed')
    );
    expect(reportErrorForDisplay('The CONFIG FILE is BROKEN', 'x').summary).toBe(
      userMessage('operation.failed')
    );
  });
});
