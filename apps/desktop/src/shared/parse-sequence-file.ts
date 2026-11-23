import {
  decodeSequenceDocument,
  type AnnotatedSequence,
  type SequenceDocument,
  type SequenceFormat,
} from '@waypoint/sequence-utils';
import { isBinarySequenceFilePath } from '@waypoint/sequence-utils/sequence-file-types';
import { isCompressedGenBankPath } from './scientific-file-types';

export function isBinarySequencePath(filePath: string): boolean {
  return isBinarySequenceFilePath(filePath);
}

export function parseSequenceFileAsDocument(
  content: string | ArrayBuffer | Uint8Array,
  filePath: string
): SequenceDocument {
  return decodeSequenceDocument(content, {
    path: filePath,
    filename: filePath.split(/[\\/]/).pop() || filePath,
    ...(isCompressedGenBankPath(filePath) ? { format: 'genbank' as const } : {}),
  });
}

export function parseBinarySequenceFileAsAnnotated(
  content: ArrayBuffer | Uint8Array,
  filePath: string
): { sequence: AnnotatedSequence; format: SequenceFormat; document: SequenceDocument } {
  const document = parseSequenceFileAsDocument(content, filePath);
  return {
    sequence: document.sequence,
    format: document.format,
    document,
  };
}

export function parseTextSequenceFileAsAnnotated(
  content: string,
  filePath: string
): { sequence: AnnotatedSequence; format: SequenceFormat; document: SequenceDocument } {
  const document = parseSequenceFileAsDocument(content, filePath);
  return {
    sequence: document.sequence,
    format: document.format,
    document,
  };
}
