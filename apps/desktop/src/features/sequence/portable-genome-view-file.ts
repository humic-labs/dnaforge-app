import {
  MAX_PORTABLE_GENOME_VIEW_BYTES,
  parsePortableGenomeViewDocument,
  serializePortableGenomeViewDocument,
  type PortableGenomeViewDocument,
} from '@waypoint/genome-data';
import { beginFileExport } from '../../lib/file-export-telemetry';

import { platform } from '../../platform';

export const PORTABLE_GENOME_VIEW_FILE_SUFFIX = '.dnaforge-genome-view.json';

const PORTABLE_GENOME_VIEW_FILE_FILTERS = [
  { name: 'DNAForge genome view', extensions: ['dnaforge-genome-view.json'] },
];
const DEFAULT_FILE_STEM = 'Genome view';
const MAX_DEFAULT_FILE_STEM_LENGTH = 80;
const WINDOWS_RESERVED_FILE_STEM = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export type PortableGenomeViewFileErrorCode =
  | 'open-dialog-failed'
  | 'read-failed'
  | 'parse-failed'
  | 'save-dialog-failed'
  | 'serialize-failed'
  | 'write-failed';

export class PortableGenomeViewFileError extends Error {
  constructor(
    readonly code: PortableGenomeViewFileErrorCode,
    message: string,
    readonly filePath: string | null,
    readonly cause: unknown
  ) {
    super(message);
    this.name = 'PortableGenomeViewFileError';
  }
}

export interface PortableGenomeViewFile {
  readonly filePath: string;
  readonly document: PortableGenomeViewDocument;
}

export function portableGenomeViewDefaultFileName(name: string): string {
  const nameWithoutSuffix = name.toLowerCase().endsWith(PORTABLE_GENOME_VIEW_FILE_SUFFIX)
    ? name.slice(0, -PORTABLE_GENOME_VIEW_FILE_SUFFIX.length)
    : name;
  const sanitized = nameWithoutSuffix
    .normalize('NFKC')
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[ .-]+|[ .-]+$/g, '')
    .slice(0, MAX_DEFAULT_FILE_STEM_LENGTH)
    .replace(/[ .-]+$/g, '');
  const stem =
    sanitized.length === 0 || WINDOWS_RESERVED_FILE_STEM.test(sanitized)
      ? DEFAULT_FILE_STEM
      : sanitized;
  return `${stem}${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`;
}

export async function openPortableGenomeViewDocument(
  filePath: string
): Promise<PortableGenomeViewFile> {
  let bytes: Uint8Array;
  try {
    bytes = await platform().fs.readFileBounded(filePath, MAX_PORTABLE_GENOME_VIEW_BYTES);
  } catch (cause) {
    throw fileError(
      'read-failed',
      `Could not read portable genome view "${filePath}": ${errorDetail(cause)}`,
      filePath,
      cause
    );
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw fileError(
      'parse-failed',
      `Portable genome view "${filePath}" is not valid UTF-8.`,
      filePath,
      cause
    );
  }

  try {
    return {
      filePath,
      document: parsePortableGenomeViewDocument(content),
    };
  } catch (cause) {
    throw fileError(
      'parse-failed',
      `Could not parse portable genome view "${filePath}": ${errorDetail(cause)}`,
      filePath,
      cause
    );
  }
}

export async function choosePortableGenomeViewDocument(): Promise<PortableGenomeViewFile | null> {
  let selected: string | string[] | null;
  try {
    selected = await platform().dialog.open({
      title: 'Open DNAForge genome view',
      filters: PORTABLE_GENOME_VIEW_FILE_FILTERS,
    });
  } catch (cause) {
    throw fileError(
      'open-dialog-failed',
      `Could not open the portable genome view picker: ${errorDetail(cause)}`,
      null,
      cause
    );
  }

  const filePath = Array.isArray(selected) ? selected[0] : selected;
  return filePath ? openPortableGenomeViewDocument(filePath) : null;
}

export async function savePortableGenomeViewDocument(
  document: PortableGenomeViewDocument
): Promise<string | null> {
  const telemetry = beginFileExport('json');
  let captured: PortableGenomeViewDocument;
  try {
    captured = structuredClone(document);
  } catch (cause) {
    telemetry?.fail('serialize_failed');
    throw fileError(
      'serialize-failed',
      `Could not capture the portable genome view: ${errorDetail(cause)}`,
      null,
      cause
    );
  }
  let selectedPath: string | null;
  try {
    selectedPath = await platform().dialog.save({
      defaultPath: portableGenomeViewDefaultFileName(captured.name),
      filters: PORTABLE_GENOME_VIEW_FILE_FILTERS,
    });
  } catch (cause) {
    telemetry?.fail('unknown', { outcomeKind: 'export_dialog_failed' });
    throw fileError(
      'save-dialog-failed',
      `Could not open the portable genome view save picker: ${errorDetail(cause)}`,
      null,
      cause
    );
  }
  if (!selectedPath) {
    telemetry?.cancel({ status: 'cancelled' });
    return null;
  }

  const filePath = selectedPath.toLowerCase().endsWith(PORTABLE_GENOME_VIEW_FILE_SUFFIX)
    ? selectedPath
    : `${selectedPath}${PORTABLE_GENOME_VIEW_FILE_SUFFIX}`;

  let content: string;
  try {
    content = serializePortableGenomeViewDocument(captured);
  } catch (cause) {
    telemetry?.fail('serialize_failed');
    throw fileError(
      'serialize-failed',
      `Could not serialize portable genome view "${filePath}": ${errorDetail(cause)}`,
      filePath,
      cause
    );
  }

  try {
    await platform().fs.writeTextFileAtomic({ path: filePath, content });
  } catch (cause) {
    telemetry?.fail('write_failed');
    throw fileError(
      'write-failed',
      `Could not write portable genome view "${filePath}": ${errorDetail(cause)}`,
      filePath,
      cause
    );
  }
  telemetry?.complete({ status: 'saved' });
  return filePath;
}

function fileError(
  code: PortableGenomeViewFileErrorCode,
  message: string,
  filePath: string | null,
  cause: unknown
): PortableGenomeViewFileError {
  return new PortableGenomeViewFileError(code, message, filePath, cause);
}

function errorDetail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
