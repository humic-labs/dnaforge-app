import {
  decodeSequenceDocument,
  getFeatureColor,
  IUPAC_EXPANSION,
  type AnnotatedSequence,
} from '@waypoint/sequence-utils';
import { isGenBankFormat, parseGenBank } from './genbank-parser';
import type {
  ParsedPlasmid,
  ReadonlySequenceInput,
  ReadonlySequenceLoadResult,
  ReadonlySequenceLoadError,
} from './types';

export { ReadonlyPlasmidViewer } from './readonly-view';
export type { ReadonlyPlasmidViewerProps, ReadonlyPlasmidView } from './readonly-view';
export type {
  ParsedPlasmid,
  PlasmidFeature,
  ReadonlyGenBankInput,
  ReadonlyGenBankLoadError,
  ReadonlyGenBankLoadErrorCode,
  ReadonlyGenBankLoadResult,
  ReadonlyRenderablePlasmid,
  ReadonlySequenceInput,
  ReadonlySequenceLoadError,
  ReadonlySequenceLoadErrorCode,
  ReadonlySequenceLoadResult,
} from './types';
import type {
  ReadonlyGenBankInput,
  ReadonlyGenBankLoadResult,
  ReadonlyRenderablePlasmid,
} from './types';

const INVALID_GENBANK: ReadonlyGenBankLoadResult = {
  ok: false,
  error: {
    code: 'INVALID_GENBANK',
    message: 'GenBank input does not contain a renderable sequence.',
  },
};

export function loadReadonlyGenBank(input: ReadonlyGenBankInput): ReadonlyGenBankLoadResult {
  if (input.kind === 'parsed') {
    return isReadonlyRenderablePlasmid(input.plasmid)
      ? { ok: true, plasmid: input.plasmid }
      : INVALID_GENBANK;
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return {
      ok: false,
      error: {
        code: 'INVALID_ENCODING',
        message: 'GenBank bytes must be valid UTF-8.',
      },
    };
  }

  if (!isGenBankFormat(content) || !hasBasePairLocus(content)) {
    return {
      ok: false,
      error: {
        code: 'UNSUPPORTED_FORMAT',
        message: 'Only DNA GenBank input is supported.',
      },
    };
  }

  try {
    const plasmid = parseGenBank(content);
    if (!isReadonlyRenderablePlasmid(plasmid)) return INVALID_GENBANK;
    return { ok: true, plasmid };
  } catch {
    return INVALID_GENBANK;
  }
}

export function loadReadonlySequence(input: ReadonlySequenceInput): ReadonlySequenceLoadResult {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return sequenceFailure('INVALID_ENCODING', 'Sequence bytes must be valid UTF-8.');
  }

  let decoded: ReturnType<typeof decodeSequenceDocument>;
  try {
    decoded = decodeSequenceDocument(content, { filename: input.filename });
  } catch {
    return sequenceFailure('INVALID_SEQUENCE', 'The published sequence could not be parsed.');
  }

  if (decoded.format !== 'fasta' && decoded.format !== 'seq') {
    return sequenceFailure(
      'UNSUPPORTED_FORMAT',
      'Only FASTA and SEQ sequence-only publications have a browser map preview.'
    );
  }

  const plasmid = toReadonlySequence(decoded.sequence);
  return isReadonlyRenderablePlasmid(plasmid)
    ? { ok: true, plasmid }
    : sequenceFailure('INVALID_SEQUENCE', 'The published sequence is not a renderable DNA record.');
}

function toReadonlySequence(sequence: AnnotatedSequence): ParsedPlasmid {
  return {
    name: sequence.name,
    length: sequence.length,
    circular: sequence.circular ?? false,
    sequence: sequence.sequence,
    features: sequence.annotations.map((annotation) => ({
      type: annotation.type,
      start: annotation.start,
      end: annotation.end,
      direction:
        annotation.direction === 1 ? 'forward' : annotation.direction === -1 ? 'reverse' : 'none',
      qualifiers: annotation.qualifiers ?? {},
      displayName: annotation.name,
      color: annotation.color ?? getFeatureColor(annotation.type),
      ...(annotation.segments ? { segments: annotation.segments } : {}),
    })),
    primers: [],
  };
}

function sequenceFailure(
  code: ReadonlySequenceLoadError['code'],
  message: string
): { ok: false; error: ReadonlySequenceLoadError } {
  return { ok: false, error: { code, message } };
}

function hasBasePairLocus(content: string): boolean {
  const locusLine = content.split(/\r?\n/u, 1)[0]?.trim() ?? '';
  return /\s\d+\s+bp\b/iu.test(locusLine);
}

function isReadonlyRenderablePlasmid(plasmid: ParsedPlasmid): plasmid is ReadonlyRenderablePlasmid {
  if (plasmid.length <= 0) return false;
  if (plasmid.sequence.length > 0 && plasmid.sequence.length !== plasmid.length) return false;
  const availableSequence =
    plasmid.sequence.length > 0 ? plasmid.sequence : (plasmid.sequenceWindow?.bases ?? '');
  if (availableSequence.length === 0) return false;

  for (const base of availableSequence) {
    if (!Object.prototype.hasOwnProperty.call(IUPAC_EXPANSION, base.toUpperCase())) return false;
  }
  return true;
}
