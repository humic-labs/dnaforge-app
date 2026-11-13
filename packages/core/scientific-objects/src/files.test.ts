import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as genbank from '@waypoint/sequence-utils/genbank';
import {
  createRevisionGraph,
  defineBlob,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
} from '@waypoint/workspace-revisions';
import { applyScientificBatch, compileScientificWorkspace, createScientificReader } from './index';
import { defineScientificFile, sequenceFileCodecs } from './files';

const must = <T, E>(value: Result<T, E>): T => {
  if (!value.ok) throw new Error(JSON.stringify(value.error));
  return value.value;
};
const text = readFileSync(
  resolve(import.meta.dirname, '../../../../test-fixtures/sequences/circular/pUC19.gb'),
  'utf8'
);
const refName = must(parseRefName('accepted'));
const resourceId = must(parseResourceId('source'));

describe('native scientific file representations', () => {
  it('does not repeatedly decode unchanged GenBank data while keeping exact content and decoder authority', () => {
    const nativeText = text.replace(
      'Cloning vector pUC19c, complete sequence.',
      'Unchanged native save regression.'
    );
    expect(nativeText).not.toBe(text);
    const parse = vi.spyOn(genbank, 'parseGenBankRecords');
    try {
      const input = { representation: { format: 'genbank-v1', text: nativeText } };
      const first = defineScientificFile(input, sequenceFileCodecs);
      const again = defineScientificFile(input, sequenceFileCodecs);
      expect(again).toEqual(first);
      expect(parse).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(again.document)).toBe(true);
      expect(again).toEqual(defineScientificFile(input, [{ ...sequenceFileCodecs[0] }]));
      const changed = defineScientificFile(
        {
          representation: {
            ...input.representation,
            text: nativeText.replace('regression.', 'changed.'),
          },
        },
        sequenceFileCodecs
      );
      expect(parse).toHaveBeenCalledTimes(3);
      expect(changed.blob.hash).not.toBe(first.blob.hash);
      expect(changed.scientificHash).not.toBe(first.scientificHash);
      expect(() => defineScientificFile(input, [])).toThrow(/unavailable/);
      expect(() =>
        defineScientificFile(input, [...sequenceFileCodecs, ...sequenceFileCodecs])
      ).toThrow(/unavailable/);
      expect(() =>
        defineScientificFile({ ...input, document: first.document }, sequenceFileCodecs)
      ).toThrow(/competing/);
      const unknownField = { representation: { ...input.representation, extra: true } };
      expect(() => defineScientificFile(unknownField, sequenceFileCodecs)).toThrow(
        /unknown fields/
      );
    } finally {
      parse.mockRestore();
    }
  });

  it('evicts older native definitions instead of retaining every opened sequence', () => {
    const parse = vi.spyOn(genbank, 'parseGenBankRecords');
    try {
      const inputs = Array.from({ length: 65 }, (_, index) => ({
        representation: {
          format: 'genbank-v1',
          text: text.replace(
            'Cloning vector pUC19c, complete sequence.',
            `Bounded native definition ${index}.`
          ),
        },
      }));
      expect(new Set(inputs.map((input) => input.representation.text)).size).toBe(65);
      for (const input of inputs) defineScientificFile(input, sequenceFileCodecs);
      expect(parse).toHaveBeenCalledTimes(65);
      defineScientificFile(inputs[64], sequenceFileCodecs);
      expect(parse).toHaveBeenCalledTimes(65);
      defineScientificFile(inputs[0], sequenceFileCodecs);
      expect(parse).toHaveBeenCalledTimes(66);
    } finally {
      parse.mockRestore();
    }
  });

  it('rejects an embedded identity mismatch in compilation and direct revision-engine submission', () => {
    const graph = createRevisionGraph({
      workspaceId: must(parseWorkspaceId('native-identities')),
      acceptedRef: refName,
    });
    const nativeText = JSON.stringify({
      id: 'embedded-id',
      document: { formatVersion: 1, kind: 'strain', name: 'BY4741', taxon: null, fields: {} },
    });
    const codecs = [
      {
        format: 'identity-test',
        mediaType: 'application/json',
        decode: (bytes: string) => JSON.parse(bytes).document,
        resourceIdentity: (bytes: string) => JSON.parse(bytes).id,
      },
    ];
    expect(() =>
      compileScientificWorkspace({
        graph,
        head: null,
        codecs,
        entries: [
          {
            resourceId,
            path: must(parseWorkspacePath('strain.json')),
            representation: { format: 'identity-test', text: nativeText },
          },
        ],
      })
    ).toThrow(/identity/i);
    const defined = defineScientificFile(
      { representation: { format: 'identity-test', text: nativeText } },
      codecs
    );
    const result = applyScientificBatch({
      graph,
      refName,
      operationId: must(parseOperationId('identity-mismatch')),
      expectedHead: null,
      codecs,
      readBlob: () => new TextEncoder().encode(nativeText),
      mutations: [
        {
          kind: 'create-resource',
          resourceId,
          path: must(parseWorkspacePath('strain.json')),
          state: defined.state,
          origin: { kind: 'created' },
        },
      ],
    });
    expect(result.kind).toBe('rejected');
  });
  it('accepts actual GenBank bytes and derives exact scientific state without rewriting them as JSON', () => {
    const graph = createRevisionGraph({
      workspaceId: must(parseWorkspaceId('native-science')),
      acceptedRef: refName,
    });
    const defined = defineScientificFile(
      { representation: { format: 'genbank-v1', text } },
      sequenceFileCodecs
    );
    expect(defined.text).toBe(text);
    expect(defined.blob).toEqual(defineBlob(new TextEncoder().encode(text)));
    expect(defined.document).toMatchObject({
      kind: 'sequence',
      name: 'SYNPUC19CV',
      topology: 'circular',
    });
    const plan = compileScientificWorkspace({
      graph,
      head: null,
      codecs: sequenceFileCodecs,
      entries: [
        {
          resourceId,
          path: must(parseWorkspacePath('source.gb')),
          representation: { format: 'genbank-v1', text },
        },
      ],
    });
    const blobs = new Map(plan.blobs.map((bytes) => [defineBlob(bytes).hash, bytes]));
    const readBlob = (blob: { hash: string }) =>
      blobs.get(blob.hash as ReturnType<typeof defineBlob>['hash']) ?? null;
    const result = applyScientificBatch({
      graph,
      refName,
      operationId: must(parseOperationId('native')),
      expectedHead: null,
      ...plan,
      codecs: sequenceFileCodecs,
      readBlob,
    });
    if (result.kind !== 'changed') throw new Error(result.kind);
    const reader = createScientificReader({
      graph: result.graph,
      head: result.version.id,
      codecs: sequenceFileCodecs,
      readBlob,
    });
    expect(reader.current(resourceId)?.document).toEqual(defined.document);
    expect(reader.current(resourceId)?.bindingInputHash).toBe(defined.bindingInputHash);
    expect(plan.blobs.some((bytes) => new TextDecoder().decode(bytes) === text)).toBe(true);
    const map = JSON.parse(new TextDecoder().decode(plan.blobs[plan.blobs.length - 1]));
    expect(map).toMatchObject({
      formatVersion: 2,
      entries: [{ resourceId: 'source', path: 'source.gb', format: 'genbank-v1' }],
    });
    expect(() =>
      createScientificReader({ graph: result.graph, head: result.version.id, readBlob }).current(
        resourceId
      )
    ).toThrow(/Invalid scientific document/);
  });
  it('refuses competing caller documents, unavailable decoders and malformed or multiple GenBank records', () => {
    for (const input of [
      { representation: { format: 'unknown', text } },
      { document: { kind: 'forged' }, representation: { format: 'genbank-v1', text } },
      { representation: { format: 'genbank-v1', text: 'broken LOCUS' } },
      { representation: { format: 'genbank-v1', text: text.replace('2686 bp', '2687 bp') } },
      { representation: { format: 'genbank-v1', text: text + text } },
    ])
      expect(() => defineScientificFile(input, sequenceFileCodecs)).toThrow();
  });
  it('keeps binding input stable for a renamed native record and changes it for altered bases', () => {
    const original = defineScientificFile(
      { representation: { format: 'genbank-v1', text } },
      sequenceFileCodecs
    );
    const renamed = defineScientificFile(
      {
        representation: {
          format: 'genbank-v1',
          text: text.replace('SYNPUC19CV', 'pUC19-renamed'),
        },
      },
      sequenceFileCodecs
    );
    expect(renamed.document).toMatchObject({ name: 'pUC19-renamed' });
    expect(renamed.blob.hash).not.toBe(original.blob.hash);
    expect(renamed.bindingInputHash).toBe(original.bindingInputHash);
    const changed = defineScientificFile(
      {
        representation: {
          format: 'genbank-v1',
          text: text.replace(/(ORIGIN\s*\n\s*\d+\s+)[acgt]/iu, '$1n'),
        },
      },
      sequenceFileCodecs
    );
    expect(changed.bindingInputHash).not.toBe(original.bindingInputHash);
  });
});
