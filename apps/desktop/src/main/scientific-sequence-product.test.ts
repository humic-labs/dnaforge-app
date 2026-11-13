import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeSequenceDocument, serializeGenBank } from '@waypoint/sequence-utils';
import { applyScientificBatch, defineScientificFile } from '@waypoint/scientific-objects';
import {
  createRevisionGraph,
  listWorkspaceResources,
  parseOperationId,
  parseRefName,
  parseResourceId,
  parseWorkspaceId,
  parseWorkspacePath,
  type Result,
} from '@waypoint/workspace-revisions';
import { composeSequenceProduct, type SequenceProductCreation } from '../shared/sequence-product';
import { scientificNativeCodecs } from './scientific-native-codecs';
import { validateScientificSequenceProductCreation } from './scientific-sequence-product';

const must = <T, E>(result: Result<T, E>): T => {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe('native sequence creation source authority', () => {
  it('replays historical source pins and refuses forged pins or altered product DNA', () => {
    const text = readFileSync(
      resolve(
        import.meta.dirname,
        '../../../../test-fixtures/scientific-object-standard/yeast-heat-recovery/pUG6.AF298793.1.gb'
      ),
      'utf8'
    );
    const source = defineScientificFile(
      { representation: { format: 'genbank-v1', text } },
      scientificNativeCodecs
    );
    const blobs = new Map([[source.blob.hash, new TextEncoder().encode(text)]]);
    const refName = must(parseRefName('accepted'));
    const donorId = must(parseResourceId('donor'));
    const before = applyScientificBatch({
      graph: createRevisionGraph({
        workspaceId: must(parseWorkspaceId('sequence-products')),
        acceptedRef: refName,
      }),
      refName,
      operationId: must(parseOperationId('import-donor')),
      expectedHead: null,
      codecs: scientificNativeCodecs,
      readBlob: (blob) => blobs.get(blob.hash) ?? null,
      mutations: [
        {
          kind: 'create-resource',
          resourceId: donorId,
          path: must(parseWorkspacePath('donor.gb')),
          state: source.state,
          origin: { kind: 'created' },
        },
      ],
    });
    if (before.kind !== 'changed') throw new Error(JSON.stringify(before));
    const slot = must(listWorkspaceResources(before.graph, before.version.id))[0];
    const creation: SequenceProductCreation = {
      schema: 'dnaforge.sequence-product-creation.v1',
      circular: false,
      parts: [
        {
          kind: 'source',
          documentId: donorId,
          start: 201,
          end: 400,
          strand: -1,
          revision: {
            resourceRevisionId: slot.revisionId,
            workspaceVersionId: before.version.id,
            contentSha256: source.blob.hash.slice('sha256:'.length),
          },
        },
      ],
    };
    const product = composeSequenceProduct(
      'Exact fragment',
      false,
      creation.parts,
      new Map([[donorId, decodeSequenceDocument(text).sequence]])
    );
    const changedText = serializeGenBank({
      ...decodeSequenceDocument(text).sequence,
      sequence: 'A'.repeat(4009),
      length: 4009,
      annotations: [],
    });
    const changed = defineScientificFile(
      { representation: { format: 'genbank-v1', text: changedText } },
      scientificNativeCodecs
    );
    blobs.set(changed.blob.hash, new TextEncoder().encode(changedText));
    const after = applyScientificBatch({
      graph: before.graph,
      refName,
      operationId: must(parseOperationId('change-donor')),
      expectedHead: before.version.id,
      codecs: scientificNativeCodecs,
      readBlob: (blob) => blobs.get(blob.hash) ?? null,
      mutations: [
        {
          kind: 'edit-resource',
          resourceId: donorId,
          expectedRevision: slot.revisionId,
          state: changed.state,
        },
      ],
    });
    if (after.kind !== 'changed') throw new Error(JSON.stringify(after));
    const input = {
      store: { readBlob: (blob: typeof source.blob) => blobs.get(blob.hash) ?? null },
      graph: after.graph,
      productText: serializeGenBank(product),
      sequencePackageText: JSON.stringify({ creationDerivation: creation }),
    };
    expect(() => validateScientificSequenceProductCreation(input)).not.toThrow();
    expect(() =>
      validateScientificSequenceProductCreation({
        ...input,
        productText: serializeGenBank({ ...product, sequence: 'A'.repeat(product.length) }),
      })
    ).toThrow('creation recipe');
    const forged = structuredClone(creation);
    if (forged.parts[0].kind !== 'source') throw new Error('Wrong fixture');
    forged.parts[0].revision.contentSha256 = '0'.repeat(64);
    expect(() =>
      validateScientificSequenceProductCreation({
        ...input,
        sequencePackageText: JSON.stringify({ creationDerivation: forged }),
      })
    ).toThrow('exact accepted source');
  });
});
