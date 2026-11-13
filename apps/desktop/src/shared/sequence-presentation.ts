import { SUPPORTED_SEQUENCE_EXTENSIONS } from './scientific-file-types';

declare const sequenceDisplayNameBrand: unique symbol;

export type SequenceDisplayName = string & {
  readonly [sequenceDisplayNameBrand]: true;
};

export interface SequencePresentation {
  readonly name: SequenceDisplayName;
}

const SEQUENCE_FILE_SUFFIX = new RegExp(
  `\\.(?:${SUPPORTED_SEQUENCE_EXTENSIONS.join('|')})(?:\\.(?:gz|bgz|bgzf))?$`,
  'iu'
);

export function sequenceDisplayName(value: unknown): SequenceDisplayName {
  const candidate = typeof value === 'string' ? value.trim() : '';
  const name = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(candidate)
    ? (candidate.split(/[\\/]/u).filter(Boolean).pop() ?? '')
    : candidate;
  return (name.replace(SEQUENCE_FILE_SUFFIX, '').trim() || 'Sequence') as SequenceDisplayName;
}

export function sequencePresentation(name: unknown): SequencePresentation {
  return Object.freeze({ name: sequenceDisplayName(name) });
}

export function quickLookSequenceDisplayName(
  sourceFileName: string,
  recordName?: string
): SequenceDisplayName {
  const source = sequenceDisplayName(sourceFileName);
  return `Quick Look / ${source}${recordName ? ` / ${sequenceDisplayName(recordName)}` : ''}` as SequenceDisplayName;
}
