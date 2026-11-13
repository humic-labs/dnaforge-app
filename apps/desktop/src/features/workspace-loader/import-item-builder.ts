import { detectFormat } from '@waypoint/sequence-utils';
import { assessImportFile } from './import-format-guard';
import type { ImportItem } from './import-wizard-state';

export interface ImportItemInput {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  content?: string;
  size?: number;
}

export function buildImportItem(input: ImportItemInput): ImportItem {
  if (input.kind === 'folder') {
    return { path: input.path, name: input.name, kind: 'folder' };
  }

  let format: string;
  try {
    format = detectFormat(input.content ?? '', input.name);
  } catch {
    format = 'unknown';
  }

  const block =
    input.content !== undefined
      ? assessImportFile({ content: input.content, filename: input.name }).block
      : undefined;

  return { path: input.path, name: input.name, kind: 'file', format, block, size: input.size };
}
