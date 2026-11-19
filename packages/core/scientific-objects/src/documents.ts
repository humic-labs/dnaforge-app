import { parseWorkTaskDocument } from './work-task';
import { IUPAC_EXPANSION } from '@waypoint/sequence-utils/iupac';
import {
  defineBlob,
  defineResourceState,
  parseResourceId,
  parseResourceRevisionId,
  type BlobHash,
  type BlobRef,
  type CanonicalValue,
  type ResourceState,
} from '@waypoint/workspace-revisions';
import { canonicalPayload, freezeJson } from './json';
import type { ScientificDocument } from './types';

export interface DefinedScientificDocument {
  readonly document: ScientificDocument;
  readonly text: string;
  readonly blob: BlobRef;
  readonly scientificHash: BlobHash;
  readonly bindingInputHash: BlobHash | null;
  readonly state: ResourceState;
}

export function defineScientificDocument(input: unknown): DefinedScientificDocument {
  const document = parseScientificDocument(input);
  const text = `${canonicalPayload(document)}\n`;
  const bytes = new TextEncoder().encode(text);
  const blob = defineBlob(bytes);
  const content = { ...document } as Record<string, unknown>;
  delete content.name;
  const scientificHash = defineBlob(new TextEncoder().encode(canonicalPayload(content))).hash;
  let bindingInputHash: BlobHash | null = null;
  if (document.kind === 'primer' || document.kind === 'sequence') {
    const bindingInput = { ...content, bases: document.bases.toUpperCase() };

    if ('annotations' in bindingInput) delete bindingInput.annotations;
    bindingInputHash = defineBlob(new TextEncoder().encode(canonicalPayload(bindingInput))).hash;
  }
  const state = defineResourceState({
    layout: 'file',
    resourceKind: `dnaforge.scientific.${document.kind}`,
    mediaType: 'application/json',
    blob,
    materialMetadata: { kind: document.kind, scientificHash, bindingInputHash },
  });
  if (!state.ok) throw new TypeError(`Invalid scientific state: ${state.error.kind}`);
  return Object.freeze({
    document,
    text,
    blob,
    scientificHash,
    bindingInputHash,
    state: state.value,
  });
}

export function parseScientificDocument(input: unknown): ScientificDocument {
  const value: unknown = JSON.parse(canonicalPayload(input));
  const document = object(value);
  if (document.formatVersion !== 1) fail('Unsupported scientific format version.');
  const kind = text(document.kind);
  const common = ['formatVersion', 'kind'];
  switch (kind) {
    case 'work-task':
      return freezeJson(
        parseWorkTaskDocument(document) as unknown as CanonicalValue
      ) as unknown as ScientificDocument;
    case 'primer': {
      keys(document, [...common, 'name', 'molecule', 'bases', 'modifications', 'fields']);
      named(document);
      molecule(document.molecule);
      const bases = nucleotide(document.bases);
      for (const raw of array(document.modifications)) {
        const modification = object(raw);
        keys(modification, ['anchor', 'code', 'details']);
        text(modification.code);
        object(modification.details);
        const anchor = object(modification.anchor);
        if (anchor.kind === 'terminus') {
          keys(anchor, ['kind', 'end']);
          oneOf(anchor.end, ['five-prime', 'three-prime']);
        } else if (anchor.kind === 'between-bases') {
          keys(anchor, ['kind', 'offset']);
          integer(anchor.offset, 0, bases.length);
        } else if (anchor.kind === 'base') {
          keys(anchor, ['kind', 'index']);
          integer(anchor.index, 0, bases.length - 1);
        } else fail('Invalid modification anchor.');
      }
      break;
    }
    case 'sequence':
      keys(document, [...common, 'name', 'molecule', 'bases', 'topology', 'annotations', 'fields']);
      named(document);
      molecule(document.molecule);
      nucleotide(document.bases, true);
      oneOf(document.topology, ['linear', 'circular']);
      array(document.annotations);
      break;
    case 'strain':
      keys(document, [...common, 'name', 'taxon', 'fields']);
      named(document);
      if (document.taxon !== null) text(document.taxon);
      break;
    case 'primer-binding': {
      keys(document, [...common, 'primerId', 'target', 'coordinates']);
      identity(document.primerId);
      pin(document.target);
      const coordinates = object(document.coordinates);
      keys(coordinates, ['start', 'end', 'strand']);
      integer(coordinates.start, 0);
      integer(coordinates.end, 0);
      oneOf(coordinates.strand, [1, -1]);
      break;
    }
    case 'binding-evidence': {
      keys(document, [...common, 'binding', 'primer', 'target', 'algorithm', 'outcome', 'result']);
      pin(document.binding);
      pin(document.primer);
      pin(document.target);
      const algorithm = object(document.algorithm);
      keys(algorithm, ['name', 'version', 'parameters']);
      text(algorithm.name);
      text(algorithm.version);
      object(algorithm.parameters);
      oneOf(document.outcome, ['valid', 'invalid']);
      object(document.result);
      break;
    }
    case 'strain-sequence':
      keys(document, [
        ...common,
        'strainId',
        'sequence',
        'assertion',
        'evidence',
        ...(Object.hasOwn(document, 'fields') ? ['fields'] : []),
      ]);
      identity(document.strainId);
      pin(document.sequence);
      assertion(document);
      if (Object.hasOwn(document, 'fields')) object(document.fields);
      break;
    case 'strain-descent':
      keys(document, [
        ...common,
        'strainId',
        'parent',
        'assertion',
        'evidence',
        ...(Object.hasOwn(document, 'fields') ? ['fields'] : []),
      ]);
      identity(document.strainId);
      pin(document.parent);
      assertion(document);
      if (Object.hasOwn(document, 'fields')) object(document.fields);
      break;
    case 'accepted-assembly':
      keys(document, [
        ...common,
        'constructId',
        'parent',
        'sources',
        'primers',
        'product',
        'recipe',
      ]);
      identity(document.constructId);
      if (document.parent !== null) pin(document.parent);
      for (const source of array(document.sources)) pin(source);
      for (const primer of array(document.primers)) pin(primer);
      pin(document.product);
      object(document.recipe);
      break;
    default:
      fail(`Unsupported scientific kind: ${kind}`);
  }
  return freezeJson(document as CanonicalValue) as unknown as ScientificDocument;
}

function fail(message: string): never {
  throw new TypeError(message);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    fail('Expected a JSON object.');
  return value as Record<string, unknown>;
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) fail('Expected an array.');
  return value;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key)))
    fail('Unknown or missing scientific fields.');
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) fail('Expected nonempty text.');
  return value;
}
function oneOf(value: unknown, allowed: readonly unknown[]): void {
  if (!allowed.includes(value)) fail('Invalid scientific field value.');
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail('Scientific coordinate is out of bounds.');
}
function identity(value: unknown): void {
  if (!parseResourceId(text(value)).ok) fail('Invalid resource identity.');
}
function pin(value: unknown): void {
  const record = object(value);
  keys(record, ['resourceId', 'revisionId']);
  identity(record.resourceId);
  if (!parseResourceRevisionId(text(record.revisionId)).ok) fail('Invalid pinned revision.');
}
function named(value: Record<string, unknown>): void {
  text(value.name);
  object(value.fields);
}
function molecule(value: unknown): void {
  oneOf(value, ['DNA', 'RNA']);
}
function nucleotide(value: unknown, allowEmpty = false): string {
  if (allowEmpty && value === '') return '';
  const bases = text(value);
  for (const base of bases)
    if (base.charCodeAt(0) > 127 || !Object.hasOwn(IUPAC_EXPANSION, base.toUpperCase()))
      fail(`Invalid nucleotide: ${base}`);
  return bases;
}
function assertion(value: Record<string, unknown>): void {
  oneOf(value.assertion, ['planned', 'observed']);
  for (const evidence of array(value.evidence)) pin(evidence);
  if (value.assertion === 'observed' && array(value.evidence).length === 0)
    fail('Observed strain assertions require evidence.');
}
