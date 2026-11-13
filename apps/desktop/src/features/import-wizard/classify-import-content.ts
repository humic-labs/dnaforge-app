import { detectFormat } from '@waypoint/sequence-utils';
import { sequenceFileTypeForPath } from '@waypoint/sequence-utils/sequence-file-types';
import { isTabularDataFile } from '../../utils/fileTypes';

export type ImportContentClass = 'opaque-asset' | 'sequence' | 'tabular';

export type ImportDisposition = 'workspace' | 'registry' | 'registry-entities';

export interface ImportContentDescriptor {
  lane: ImportContentClass;
  defaultDisposition: ImportDisposition;
  allowedDispositions: readonly ImportDisposition[];
}

const SEQUENCE_DISPOSITIONS: readonly ImportDisposition[] = ['workspace', 'registry'];
const OPAQUE_DISPOSITIONS: readonly ImportDisposition[] = ['workspace'];
const TABULAR_DISPOSITIONS: readonly ImportDisposition[] = ['workspace', 'registry-entities'];

export function classifyImportContent(input: {
  name: string;
  content?: string;
  sizeBytes?: number;
}): ImportContentClass {
  const fileType = sequenceFileTypeForPath(input.name);

  if (isTabularDataFile(input.name)) {
    return 'tabular';
  }

  if (fileType) {
    if (input.content === undefined) {
      return 'sequence';
    }
    if (fileType.encoding === 'binary') {
      return 'sequence';
    }
    try {
      detectFormat(input.content);
      return 'sequence';
    } catch {
      return 'opaque-asset';
    }
  }

  return 'opaque-asset';
}

export function describeImportContent(input: {
  name: string;
  content?: string;
  sizeBytes?: number;
}): ImportContentDescriptor {
  const lane = classifyImportContent(input);
  switch (lane) {
    case 'sequence':
      return { lane, defaultDisposition: 'workspace', allowedDispositions: SEQUENCE_DISPOSITIONS };
    case 'tabular':
      return {
        lane,
        defaultDisposition: 'workspace',
        allowedDispositions: TABULAR_DISPOSITIONS,
      };
    case 'opaque-asset':
      return { lane, defaultDisposition: 'workspace', allowedDispositions: OPAQUE_DISPOSITIONS };
  }
}
