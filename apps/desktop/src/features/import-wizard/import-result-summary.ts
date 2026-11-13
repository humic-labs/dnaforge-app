import { userMessage, userMessageValue, userMessageWithValues } from '@waypoint/user-messages';
import type { ImportExecResult } from './execute-import-outcome';
import type { ToastType } from '../../stores/toast-store';

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

function summarizeSkips(r: ImportExecResult): {
  parts: string[];
  duplicates: number;
  validation: number;
} {
  let duplicates = r.skipBreakdown?.duplicates ?? 0;
  let validation = r.skipBreakdown?.validation ?? 0;
  if (
    !Number.isSafeInteger(duplicates) ||
    duplicates < 0 ||
    !Number.isSafeInteger(validation) ||
    validation < 0 ||
    duplicates + validation > r.skipped
  ) {
    duplicates = 0;
    validation = 0;
  }
  const unknown = Math.max(0, r.skipped - duplicates - validation);
  const parts: string[] = [];
  if (duplicates > 0) parts.push(`skipped ${plural(duplicates, 'duplicate')}`);
  if (validation > 0) parts.push(`skipped ${plural(validation, 'item')} that failed validation`);
  if (unknown > 0) parts.push(`skipped ${plural(unknown, 'item')}`);
  return { parts, duplicates, validation };
}

export function summarizeImportResult(r: ImportExecResult): { message: string; type: ToastType } {
  const skips = summarizeSkips(r);
  const done: string[] = [];
  if (r.imported > 0) done.push(`Imported ${plural(r.imported, 'item')}`);
  done.push(...skips.parts);

  if (r.failed > 0) {
    const writtenSources = new Set(r.written.map((item) => item.sourcePath));
    const partialErrors = r.errors.filter((error) => writtenSources.has(error.sourcePath));
    const partialCount = partialErrors.length;
    const cleanImported = Math.max(0, r.imported - partialCount);
    const fullyFailed = Math.max(0, r.failed - partialCount);
    const parts: string[] = [];
    if (cleanImported > 0) parts.push(`Imported ${plural(cleanImported, 'item')}`);
    if (partialCount > 0) {
      parts.push(
        `Copied ${plural(partialCount, 'item')}, but registry registration did not complete`
      );
    }
    parts.push(...skips.parts);
    if (fullyFailed > 0) parts.push(`${plural(fullyFailed, 'item')} failed`);
    const fullyFailedError = r.errors.find((error) => !writtenSources.has(error.sourcePath));
    const reason = fullyFailedError?.error ?? partialErrors[0]?.error ?? r.errors[0]?.error;
    return {
      message: `${parts.join(' · ')}${reason ? ` — ${reason}` : ''}`,
      type: 'error',
    };
  }
  if (r.imported === 0) {
    if (r.skipped > 0) {
      const details = skips.parts.join(' · ');
      return {
        message:
          skips.duplicates === r.skipped
            ? userMessageWithValues('importResult.alreadyImported', {
                details: userMessageValue(details),
              })
            : userMessageWithValues('importResult.summary', {
                summary: userMessageValue(`${details.charAt(0).toUpperCase()}${details.slice(1)}`),
              }),
        type: skips.validation > 0 ? 'warning' : 'info',
      };
    }
    return {
      message: userMessage('importResult.nothingImported'),
      type: 'warning',
    };
  }
  const summary = userMessageValue(done.join(' · '));
  return {
    message: r.createdNewWorkspace
      ? userMessageWithValues('importResult.summaryIntoProject', {
          summary,
          project: userMessageValue(r.createdWorkspaceName ?? 'new project'),
        })
      : userMessageWithValues('importResult.summary', { summary }),
    type: skips.validation > 0 ? 'warning' : 'success',
  };
}
