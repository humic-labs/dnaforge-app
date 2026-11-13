import { parseGenBankRecords } from '@waypoint/sequence-utils/genbank';
import {
  defineBlob,
  defineResourceState,
  parseResourceId,
  type CanonicalMap,
  type ResourceId,
} from '@waypoint/workspace-revisions';
import { defineScientificDocument, type DefinedScientificDocument } from './documents';
import { parseUniqueJson } from './unique-json';
import type {
  ScientificDocument,
  ScientificFileRepresentation,
  ScientificIssue,
  ScientificReader,
  ScientificSnapshot,
} from './types';
export type { ScientificFileRepresentation } from './types';

export type ScientificFileContent =
  | { readonly document: unknown; readonly representation?: never }
  | { readonly representation: ScientificFileRepresentation; readonly document?: never };

export interface ScientificFileCodec {
  readonly format: string;
  readonly mediaType: string;
  readonly decode: (text: string) => unknown;

  readonly resourceIdentity?: (text: string) => string;

  readonly bindingFields?: (document: ScientificDocument) => CanonicalMap;

  readonly validateReferences?: (input: {
    readonly snapshot: ScientificSnapshot;
    readonly reader: ScientificReader;
  }) => readonly ScientificIssue[];
}

export interface DefinedScientificFile extends DefinedScientificDocument {
  readonly nativeResourceId?: ResourceId;
}

const genBankDefinitions = new Map<string, DefinedScientificFile>();
const MAX_GENBANK_DEFINITIONS = 64;
const MAX_GENBANK_SOURCE_BYTES = 64 * 1024 * 1024;
let genBankSourceBytes = 0;

export function defineScientificFile(
  input: { readonly document?: unknown; readonly representation?: ScientificFileRepresentation },
  codecs: readonly ScientificFileCodec[] = []
): DefinedScientificFile {
  if (!Object.hasOwn(input, 'representation')) return defineScientificDocument(input.document);
  if (Object.hasOwn(input, 'document'))
    throw new TypeError('Native scientific files cannot supply a competing scientific document.');
  const representation = input.representation;
  if (
    !representation ||
    typeof representation.format !== 'string' ||
    typeof representation.text !== 'string'
  )
    throw new TypeError('Scientific file representation requires its format and exact text.');
  if (Object.keys(representation).some((key) => key !== 'format' && key !== 'text'))
    throw new TypeError('Scientific file representation has unknown fields.');
  const matching = codecs.filter((codec) => codec.format === representation.format);
  if (matching.length !== 1)
    throw new TypeError(`Scientific file decoder unavailable: ${representation.format}`);
  const codec = matching[0];
  const cacheable = codec === sequenceFileCodecs[0];
  const cached = cacheable ? genBankDefinitions.get(representation.text) : undefined;
  if (cached) {
    genBankDefinitions.delete(representation.text);
    genBankDefinitions.set(representation.text, cached);
    return cached;
  }
  const bytes = new TextEncoder().encode(representation.text);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== representation.text)
    throw new TypeError('Scientific file contains invalid Unicode.');
  const defined = defineScientificDocument(codec.decode(representation.text));
  const identity = codec.resourceIdentity?.(representation.text);
  if (codec.resourceIdentity && typeof identity !== 'string')
    throw new TypeError('Native scientific file identity is missing.');
  const nativeResourceId = identity === undefined ? undefined : parseResourceId(identity);
  if (nativeResourceId && !nativeResourceId.ok)
    throw new TypeError('Native scientific file identity is invalid.');
  const bindingInputHash =
    codec.bindingFields &&
    (defined.document.kind === 'sequence' || defined.document.kind === 'primer')
      ? defineScientificDocument({
          ...defined.document,
          fields: codec.bindingFields(defined.document),
        }).bindingInputHash
      : defined.bindingInputHash;
  const blob = defineBlob(bytes);
  const state = defineResourceState({
    layout: 'file',
    resourceKind: `dnaforge.scientific.${defined.document.kind}`,
    mediaType: codec.mediaType,
    blob,
    materialMetadata: {
      representation: codec.format,
      kind: defined.document.kind,
      scientificHash: defined.scientificHash,
      bindingInputHash,
    },
  });
  if (!state.ok) throw new TypeError(`Invalid scientific representation: ${state.error.kind}`);
  const result = Object.freeze({
    ...defined,
    text: representation.text,
    blob,
    state: state.value,
    bindingInputHash,
    ...(nativeResourceId?.ok ? { nativeResourceId: nativeResourceId.value } : {}),
  });
  const sourceBytes = representation.text.length * 2;
  if (cacheable && sourceBytes <= MAX_GENBANK_SOURCE_BYTES) {
    while (
      genBankDefinitions.size >= MAX_GENBANK_DEFINITIONS ||
      genBankSourceBytes + sourceBytes > MAX_GENBANK_SOURCE_BYTES
    ) {
      const oldest = genBankDefinitions.keys().next().value;
      if (oldest === undefined) break;
      genBankDefinitions.delete(oldest);
      genBankSourceBytes -= oldest.length * 2;
    }
    genBankDefinitions.set(representation.text, result);
    genBankSourceBytes += sourceBytes;
  }
  return result;
}

export function snapshotScientificFile(
  input: { readonly document?: unknown; readonly representation?: ScientificFileRepresentation },
  codecs: readonly ScientificFileCodec[] = []
): ScientificFileContent {
  const defined = defineScientificFile(input, codecs);
  const representation = input.representation;
  if (Object.hasOwn(input, 'representation') && representation)
    return Object.freeze({
      representation: Object.freeze({ format: representation.format, text: defined.text }),
    });
  return Object.freeze({ document: defined.document });
}

export const sequenceFileCodecs: readonly ScientificFileCodec[] = Object.freeze([
  Object.freeze({
    format: 'genbank-v1',
    mediaType: 'text/x-genbank',
    decode: (text: string) => {
      const records = parseGenBankRecords(text);
      if (records.length !== 1)
        throw new TypeError('Each scientific sequence identity requires one GenBank record.');
      const sequence = records[0];
      const locus = text.match(/^LOCUS\s+.*$/mu)?.[0];
      if (!locus || !/\d+\s+bp\b/u.test(locus))
        throw new TypeError('Scientific GenBank sequences require a nucleotide LOCUS.');
      if (sequence.length !== sequence.sequence.length)
        throw new TypeError('GenBank declared length does not match its nucleotide payload.');
      return {
        formatVersion: 1,
        kind: 'sequence',
        name: sequence.name,
        molecule: /\b(?:ss-|ds-|ms-)?RNA\b/u.test(locus) ? 'RNA' : 'DNA',
        bases: sequence.sequence,
        topology: sequence.circular ? 'circular' : 'linear',

        annotations: json(sequence.annotations),
        fields: json({
          ...(sequence.description === undefined ? {} : { description: sequence.description }),
          ...(sequence.chosenGeneticCode ? { chosenGeneticCode: sequence.chosenGeneticCode } : {}),
          ...(sequence.unreadableGeneticCode
            ? { unreadableGeneticCode: sequence.unreadableGeneticCode }
            : {}),
        }),
      };
    },

    bindingFields: () => ({}),
  }),
]);

function json(value: unknown): unknown {
  return parseUniqueJson(JSON.stringify(value), { maxDepth: 64 });
}
