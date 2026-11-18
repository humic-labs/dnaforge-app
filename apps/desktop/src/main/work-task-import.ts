import { basename } from 'node:path';
import { scientificIdentityPath } from '@waypoint/scientific-objects';

export function isWorkImportCandidate(path: string): boolean {
  return path.toLowerCase().endsWith('.task.json') || isScientificMap(path);
}

function isScientificMap(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized === scientificIdentityPath || normalized.endsWith('/' + scientificIdentityPath);
}

export function assertIndependentWorkImport(path: string, text: string) {
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return;
  }
  if (!record || typeof record !== 'object') return;
  const containsTask = isScientificMap(path)
    ? Array.isArray(record.entries) &&
      record.entries.some(
        (entry: unknown) =>
          entry && typeof entry === 'object' && 'format' in entry && entry.format === 'work-task-v1'
      )
    : basename(path).toLowerCase().endsWith('.task.json') &&
      record.kind === 'work-task' &&
      record.formatVersion === 1;
  if (containsTask)
    throw new Error(
      'Project tasks require new identities for an independent copy. Open the original project or create a new task in the destination.'
    );
}
